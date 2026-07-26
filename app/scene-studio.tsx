"use client";

import Image from "next/image";
import {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { decodeDgsi, SceneManifest, validateManifest } from "./scene-format";
import { lookAroundYaw, normalizedTourProgress } from "./spatial-motion";

type Theme = "dark" | "light";
type ViewMode = "explore" | "source" | "coverage" | "inspect";
type Navigation = "look" | "walk";
type SceneClass = "panorama-context" | "preview-proxy" | "imported-gaussian";
type SceneOrigin = "eso" | "generated" | "spz";
type ExampleId = "eso" | "kitchen" | "venetian" | "custom";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  spark: SparkRenderer;
  splat: SplatMesh | null;
  splatUrl: string | null;
  proxy: THREE.Points;
  proxyGeometry: THREE.BufferGeometry;
  environment: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  environmentTexture: THREE.Texture | null;
  yaw: number;
  pitch: number;
  distance: number;
  target: THREE.Vector3;
  walkPosition: THREE.Vector3;
  safeMin: THREE.Vector3;
  safeMax: THREE.Vector3;
  navigation: Navigation;
  sceneClass: SceneClass;
  dragging: boolean;
  moved: boolean;
  lastPointer: { x: number; y: number };
  keys: Set<string>;
  tour: "off" | "path" | "look";
  tourStart: number;
  tourDuration: number;
  tourCurve: THREE.CatmullRomCurve3;
  lastTime: number;
};

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const DEFAULT_MANIFEST = `${PUBLIC_BASE_PATH}/room-demo/manifest.json`;
const CONTEXT_URL = `${PUBLIC_BASE_PATH}/captures/eso-guesthouse/context-webgl.jpg`;
const API_BASE = process.env.NEXT_PUBLIC_DGSI_API_URL ?? "http://127.0.0.1:8016";
const SOURCE_VIEWS = ["000", "030", "060", "090", "120", "150", "180", "210", "240", "270", "300", "330"];

const VIEW_LABELS: Record<ViewMode, string> = {
  explore: "Explore",
  source: "Source match",
  coverage: "Coverage",
  inspect: "Inspect",
};

function updateLookCamera(runtime: Runtime) {
  runtime.pitch = THREE.MathUtils.clamp(runtime.pitch, -1.35, 1.35);
  const direction = new THREE.Vector3(
    Math.sin(runtime.yaw) * Math.cos(runtime.pitch),
    Math.sin(runtime.pitch),
    -Math.cos(runtime.yaw) * Math.cos(runtime.pitch),
  );
  runtime.camera.position.copy(runtime.walkPosition);
  runtime.camera.lookAt(runtime.walkPosition.clone().add(direction));
}

function updateOrbitCamera(runtime: Runtime) {
  runtime.pitch = THREE.MathUtils.clamp(runtime.pitch, -1.15, 1.15);
  runtime.distance = THREE.MathUtils.clamp(runtime.distance, 0.7, 16);
  const cp = Math.cos(runtime.pitch);
  runtime.camera.position.set(
    runtime.target.x + Math.sin(runtime.yaw) * cp * runtime.distance,
    runtime.target.y + Math.sin(runtime.pitch) * runtime.distance,
    runtime.target.z + Math.cos(runtime.yaw) * cp * runtime.distance,
  );
  runtime.camera.lookAt(runtime.target);
}

function setCameraFromPath(runtime: Runtime, progress: number) {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  const position = runtime.tourCurve.getPointAt(t);
  const tangent = runtime.tourCurve.getTangentAt(t).normalize();
  const lookTarget = position.clone().add(tangent);
  const matrix = new THREE.Matrix4().lookAt(position, lookTarget, new THREE.Vector3(0, 1, 0));
  const desired = new THREE.Quaternion().setFromRotationMatrix(matrix);
  runtime.camera.position.lerp(position, 0.16);
  runtime.camera.quaternion.slerp(desired, 0.16);
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
      else child.material?.dispose();
    }
  });
}

export function SceneStudio() {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [mode, setMode] = useState<ViewMode>("explore");
  const [navigation, setNavigation] = useState<Navigation>("look");
  const [sceneClass, setSceneClass] = useState<SceneClass>("panorama-context");
  const [sceneOrigin, setSceneOrigin] = useState<SceneOrigin>("eso");
  const [sceneTitle, setSceneTitle] = useState("ESO Guesthouse · Vitacura");
  const [exampleId, setExampleId] = useState<ExampleId>("eso");
  const [trainedSource, setTrainedSource] = useState<{
    label: string;
    license: string;
    url?: string;
  } | null>(null);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [contextEnabled, setContextEnabled] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [filmstripOpen, setFilmstripOpen] = useState(true);
  const [selectedSource, setSelectedSource] = useState(0);
  const [progress, setProgress] = useState(0);
  const [fps, setFps] = useState(60);
  const [notice, setNotice] = useState("Real 360° photographic context · not trained 3DGS");
  const [tour, setTour] = useState<"off" | "path" | "look">("off");
  const [quality, setQuality] = useState(100);
  const [exposure, setExposure] = useState(100);
  const [ingesting, setIngesting] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const classification = useMemo(() => {
    if (sceneClass === "imported-gaussian") {
      return {
        label: "Imported anisotropic Gaussian",
        detail: "SPZ / SOG · scales · rotations · opacity · spherical harmonics when present",
        tone: "verified",
      };
    }
    if (sceneClass === "preview-proxy") {
      return {
        label: "CPU preview proxy",
        detail: "RGB points · isotropic scale · not optimized 3DGS",
        tone: "warning",
      };
    }
    return {
      label: "360° photographic capture",
      detail: "Observed ESO panorama · context projection · not trained 3DGS",
      tone: "observed",
    };
  }, [sceneClass]);
  const availableViewModes: ViewMode[] = sceneOrigin === "eso"
    ? ["explore", "source", "coverage", "inspect"]
    : ["explore", "inspect"];

  const resetCamera = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.tour = "off";
    setTour("off");
    runtime.yaw = 0;
    runtime.pitch = 0;
    runtime.distance = runtime.sceneClass === "imported-gaussian" ? 4.4 : 0.9;
    runtime.walkPosition.set(0, 0, 0);
    runtime.target.set(0, 0, 0);
    runtime.camera.fov = 54;
    runtime.camera.updateProjectionMatrix();
    if (runtime.sceneClass === "imported-gaussian") updateOrbitCamera(runtime);
    else updateLookCamera(runtime);
    setNavigation("look");
    setNotice("View reset to the registered entry pose");
  }, []);

  const setActiveMode = useCallback((next: ViewMode) => {
    const runtime = runtimeRef.current;
    setMode(next);
    if (!runtime) return;
    if (next === "inspect") {
      runtime.proxy.visible = runtime.sceneClass !== "imported-gaussian";
      runtime.environment.visible = false;
      if (runtime.splat) runtime.splat.visible = true;
      setSceneClass(runtime.sceneClass === "imported-gaussian" ? "imported-gaussian" : "preview-proxy");
      setNotice(
        runtime.sceneClass === "imported-gaussian"
          ? "Inspecting imported anisotropic Gaussian data"
          : "Engineering proxy inspection · this point representation is not trained 3DGS",
      );
    } else {
      runtime.proxy.visible = false;
      runtime.environment.visible = contextEnabled && Boolean(runtime.environmentTexture);
      if (runtime.splat) runtime.splat.visible = true;
      setSceneClass(runtime.sceneClass);
      if (next === "coverage") setNotice("Safe movement hull and registered source directions");
      else if (next === "source") setNotice("Nearest observed source compared with the active view");
      else setNotice(runtime.sceneClass === "imported-gaussian" ? "True Gaussian scene · imported SPZ" : "Real 360° photographic context · not trained 3DGS");
    }
  }, [contextEnabled]);

  useEffect(() => {
    const stored = window.localStorage.getItem("dgsi-theme");
    const preferred: Theme = stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = preferred;
    const frame = window.requestAnimationFrame(() => setTheme(preferred));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#080908");
    const camera = new THREE.PerspectiveCamera(54, 1, 0.02, 120);
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    const environment = new THREE.Mesh(
      new THREE.SphereGeometry(24, 96, 64),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, toneMapped: false }),
    );
    scene.add(environment);

    const proxyGeometry = new THREE.BufferGeometry();
    const proxy = new THREE.Points(
      proxyGeometry,
      new THREE.PointsMaterial({
        size: 0.035,
        vertexColors: true,
        transparent: true,
        opacity: 0.92,
        sizeAttenuation: true,
      }),
    );
    proxy.visible = false;
    scene.add(proxy);

    const tourCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.25, 0.03, -0.18),
        new THREE.Vector3(0.18, -0.02, -0.42),
        new THREE.Vector3(-0.18, 0.02, -0.36),
        new THREE.Vector3(-0.25, 0.01, -0.12),
        new THREE.Vector3(0, 0, 0),
      ],
      false,
      "centripetal",
      0.35,
    );

    const runtime: Runtime = {
      renderer, scene, camera, spark, splat: null, splatUrl: null,
      proxy, proxyGeometry, environment, environmentTexture: null,
      yaw: 0, pitch: 0, distance: 0.9, target: new THREE.Vector3(),
      walkPosition: new THREE.Vector3(), safeMin: new THREE.Vector3(-0.42, -0.18, -0.54),
      safeMax: new THREE.Vector3(0.42, 0.18, 0.24), navigation: "look",
      sceneClass: "panorama-context", dragging: false, moved: false,
      lastPointer: { x: 0, y: 0 }, keys: new Set(), tour: "off",
      tourStart: 0, tourDuration: 12000, tourCurve, lastTime: performance.now(),
    };
    runtimeRef.current = runtime;
    updateLookCamera(runtime);

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      camera.aspect = rect.width / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    new THREE.TextureLoader().load(
      CONTEXT_URL,
      (texture) => {
        if (runtimeRef.current !== runtime) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.repeat.x = -1;
        texture.offset.x = 1;
        texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
        runtime.environmentTexture = texture;
        runtime.environment.material.map = texture;
        runtime.environment.material.needsUpdate = true;
        runtime.environment.visible = true;
        setProgress(100);
      },
      (event) => setProgress(event.total ? Math.round(event.loaded / event.total * 100) : 35),
      () => setNotice("The photographic context could not be loaded"),
    );

    const controller = new AbortController();
    Promise.all([
      fetch(DEFAULT_MANIFEST, { signal: controller.signal }).then((response) => response.json()),
      fetch(`${PUBLIC_BASE_PATH}/room-demo/scene.dgsi`, { signal: controller.signal }).then((response) => response.arrayBuffer()),
    ]).then(([rawManifest, binary]) => {
      if (runtimeRef.current !== runtime) return;
      const checked = validateManifest(rawManifest);
      const decoded = decodeDgsi(binary, checked);
      setManifest(checked);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(decoded.colors, 3));
      runtime.proxy.geometry.dispose();
      runtime.proxy.geometry = geometry;
      runtime.proxyGeometry = geometry;
      runtime.safeMin.fromArray(checked.spatial.navigable_bounds.min);
      runtime.safeMax.fromArray(checked.spatial.navigable_bounds.max);
    }).catch(() => {
      if (!controller.signal.aborted) setNotice("Photographic context ready · proxy inspection unavailable");
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) return;
      if ((event.target as HTMLElement | null)?.matches("input, button, select, textarea")) return;
      runtime.keys.add(event.code);
      if (runtime.navigation === "walk") event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => runtime.keys.delete(event.code);
    const onBlur = () => runtime.keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    let frames = 0;
    let fpsStart = performance.now();
    renderer.setAnimationLoop((now) => {
      const delta = Math.min(0.05, Math.max(0, (now - runtime.lastTime) / 1000));
      runtime.lastTime = now;
      if (runtime.tour === "path") {
        const elapsed = normalizedTourProgress(now, runtime.tourStart, runtime.tourDuration);
        if (elapsed >= 1) {
          runtime.tour = "off";
          setTour("off");
        } else {
          setCameraFromPath(runtime, elapsed);
        }
      } else if (runtime.tour === "look") {
        const elapsed = normalizedTourProgress(now, runtime.tourStart, runtime.tourDuration);
        if (elapsed >= 1) {
          runtime.yaw = 0;
          runtime.tour = "off";
          setTour("off");
        } else {
          runtime.yaw = lookAroundYaw(elapsed);
        }
        updateLookCamera(runtime);
      } else if (runtime.navigation === "walk" && runtime.keys.size) {
        const boost = runtime.keys.has("ShiftLeft") || runtime.keys.has("ShiftRight") ? 2.4 : 1;
        const forward = new THREE.Vector3(Math.sin(runtime.yaw), 0, -Math.cos(runtime.yaw));
        const right = new THREE.Vector3(Math.cos(runtime.yaw), 0, Math.sin(runtime.yaw));
        const move = new THREE.Vector3();
        if (runtime.keys.has("KeyW") || runtime.keys.has("ArrowUp")) move.add(forward);
        if (runtime.keys.has("KeyS") || runtime.keys.has("ArrowDown")) move.sub(forward);
        if (runtime.keys.has("KeyD") || runtime.keys.has("ArrowRight")) move.add(right);
        if (runtime.keys.has("KeyA") || runtime.keys.has("ArrowLeft")) move.sub(right);
        if (move.lengthSq()) {
          runtime.walkPosition.add(move.normalize().multiplyScalar(delta * 0.42 * boost));
          runtime.walkPosition.clamp(runtime.safeMin, runtime.safeMax);
          updateLookCamera(runtime);
        }
      }
      renderer.render(scene, camera);
      frames += 1;
      if (now - fpsStart > 650) {
        setFps(Math.round(frames * 1000 / (now - fpsStart)));
        frames = 0;
        fpsStart = now;
      }
    });

    return () => {
      controller.abort();
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      renderer.setAnimationLoop(null);
      runtime.splat?.dispose();
      if (runtime.splatUrl) URL.revokeObjectURL(runtime.splatUrl);
      runtime.environmentTexture?.dispose();
      spark.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      mount.removeChild(renderer.domElement);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.navigation = navigation;
    runtime.keys.clear();
    if (navigation === "walk") {
      runtime.tour = "off";
      runtime.walkPosition.clamp(runtime.safeMin, runtime.safeMax);
      updateLookCamera(runtime);
    }
  }, [navigation]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.renderer.toneMappingExposure = exposure / 100;
    runtime.environment.material.color.setScalar(exposure / 100);
  }, [exposure]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const mount = mountRef.current;
    if (!runtime || !mount) return;
    const scale = quality >= 90 ? 2 : quality >= 65 ? 1.5 : 1;
    runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio, scale));
    const rect = mount.getBoundingClientRect();
    runtime.renderer.setSize(rect.width, rect.height, false);
    if (runtime.splat) runtime.splat.lodScale = THREE.MathUtils.lerp(0.55, 1.15, quality / 100);
    const proxyMaterial = runtime.proxy.material as THREE.PointsMaterial;
    proxyMaterial.opacity = THREE.MathUtils.lerp(0.68, 0.94, quality / 100);
  }, [quality]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.environment.visible = contextEnabled && mode !== "inspect" && Boolean(runtime.environmentTexture);
  }, [contextEnabled, mode]);

  const startTour = (kind: "path" | "look") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.tour = kind;
    runtime.tourStart = performance.now();
    runtime.tourDuration = kind === "look" ? 11000 : 14000;
    setTour(kind);
    setNavigation("look");
    setMode("explore");
    setSceneClass(runtime.sceneClass);
    runtime.proxy.visible = false;
    runtime.environment.visible = contextEnabled && Boolean(runtime.environmentTexture);
    setNotice(kind === "look" ? "Smooth 360° look-around · one continuous revolution" : "Arc-length camera path · quaternion-smoothed orientation");
  };

  const loadProxyScene = async (sceneUrl: string, origin: "eso" | "generated" = "generated") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const manifestUrl = new URL(sceneUrl, window.location.href);
    const rawManifest = await fetch(manifestUrl).then((response) => {
      if (!response.ok) throw new Error(`Scene manifest returned ${response.status}`);
      return response.json();
    });
    const checked = validateManifest(rawManifest);
    const binaryUrl = new URL(checked.binary_url, manifestUrl);
    const environmentUrl = checked.environment
      ? origin === "eso"
        ? CONTEXT_URL
        : new URL(checked.environment.url, manifestUrl).toString()
      : null;
    const [binary, texture] = await Promise.all([
      fetch(binaryUrl).then((response) => {
        if (!response.ok) throw new Error(`Scene binary returned ${response.status}`);
        return response.arrayBuffer();
      }),
      environmentUrl ? new THREE.TextureLoader().loadAsync(environmentUrl) : Promise.resolve(null),
    ]);
    const decoded = decodeDgsi(binary, checked);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(decoded.colors, 3));
    runtime.proxy.geometry.dispose();
    runtime.proxy.geometry = geometry;
    runtime.proxyGeometry = geometry;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.repeat.x = -1;
      texture.offset.x = 1;
      texture.anisotropy = Math.min(16, runtime.renderer.capabilities.getMaxAnisotropy());
      runtime.environmentTexture?.dispose();
      runtime.environmentTexture = texture;
      runtime.environment.material.map = texture;
      runtime.environment.material.needsUpdate = true;
    }
    runtime.sceneClass = origin === "eso" ? "panorama-context" : "preview-proxy";
    runtime.scene.background = new THREE.Color(origin === "eso" ? "#080908" : "#24211f");
    runtime.safeMin.fromArray(checked.spatial.navigable_bounds.min);
    runtime.safeMax.fromArray(checked.spatial.navigable_bounds.max);
    runtime.walkPosition.fromArray(checked.spatial.entry_pose.position).clamp(runtime.safeMin, runtime.safeMax);
    runtime.proxy.visible = false;
    runtime.environment.visible = Boolean(texture);
    setManifest(checked);
    setSceneTitle(origin === "eso" ? "ESO Guesthouse · Vitacura" : checked.title);
    setSceneClass(runtime.sceneClass);
    setSceneOrigin(origin);
    setExampleId(origin === "eso" ? "eso" : "custom");
    setTrainedSource(null);
    setContextEnabled(Boolean(texture));
    setMode("explore");
    setNavigation("look");
    setProgress(100);
    updateLookCamera(runtime);
  };

  const restoreEsoScene = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setIngesting(true);
    setProgress(5);
    setNotice("Restoring the observed ESO 360° room");
    try {
      if (runtime.splat) {
        runtime.scene.remove(runtime.splat);
        runtime.splat.dispose();
        runtime.splat = null;
      }
      await loadProxyScene(DEFAULT_MANIFEST, "eso");
      setNotice("Real 360° photographic context · not trained 3DGS");
    } catch (error) {
      setNotice(error instanceof Error ? `ESO room could not be restored: ${error.message}` : "ESO room could not be restored");
    } finally {
      setIngesting(false);
    }
  };

  const activateGaussian = async (
    nextSplat: SplatMesh,
    title: string,
    source: { label: string; license: string; url?: string },
  ) => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("Viewer is not ready");
    await nextSplat.initialized;
    const bounds = nextSplat.getBoundingBox();
    const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    const size = bounds.isEmpty() ? new THREE.Vector3(3, 3, 3) : bounds.getSize(new THREE.Vector3());
    const radius = Math.max(0.5, size.length() * 0.5);
    const fittedMin = bounds.isEmpty()
      ? center.clone().addScalar(-radius)
      : bounds.min.clone();
    const fittedMax = bounds.isEmpty()
      ? center.clone().addScalar(radius)
      : bounds.max.clone();
    const previousSplat = runtime.splat;
    runtime.scene.add(nextSplat);
    runtime.splat = nextSplat;
    if (previousSplat) {
      runtime.scene.remove(previousSplat);
      previousSplat.dispose();
    }
    runtime.sceneClass = "imported-gaussian";
    runtime.scene.background = new THREE.Color("#24211f");
    setSceneClass("imported-gaussian");
    setSceneOrigin("spz");
    setExampleId(source.label.startsWith("AWS") && title.startsWith("Kitchen")
      ? "kitchen"
      : source.label.startsWith("AWS")
        ? "venetian"
        : "custom");
    setSceneTitle(title);
    setTrainedSource(source);
    setManifest(null);
    runtime.proxy.visible = false;
    runtime.environment.visible = false;
    setContextEnabled(false);
    runtime.target.copy(center);
    runtime.safeMin.copy(fittedMin).addScalar(-radius * 0.1);
    runtime.safeMax.copy(fittedMax).addScalar(radius * 0.1);
    runtime.distance = radius * 1.7;
    runtime.camera.near = Math.max(0.01, radius / 1000);
    runtime.camera.far = Math.max(120, radius * 20);
    runtime.camera.updateProjectionMatrix();
    updateOrbitCamera(runtime);
    setProgress(100);
    setMode("explore");
    setNotice("Trained Gaussian ready · Spark anisotropic rendering");
  };

  const loadGaussianFile = async (file: File) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    let candidate: SplatMesh | null = null;
    setIngesting(true);
    setProgress(5);
    setNotice("Validating and loading anisotropic Gaussian data");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const nextSplat = new SplatMesh({
        fileBytes: bytes,
        fileName: file.name,
        lod: "quality",
        onProgress: (event) => setProgress(event.total ? Math.round(event.loaded / event.total * 100) : 40),
      });
      candidate = nextSplat;
      nextSplat.lodScale = THREE.MathUtils.lerp(0.55, 1.15, quality / 100);
      await activateGaussian(nextSplat, file.name.replace(/\.(?:spz|sog)$/i, ""), {
        label: "Local file · user-provided",
        license: "User supplied",
      });
      candidate = null;
    } catch (error) {
      candidate?.dispose();
      setNotice(error instanceof Error ? `Gaussian scene could not be opened: ${error.message}` : "Gaussian scene could not be opened");
    } finally {
      setIngesting(false);
    }
  };

  const loadBundledGaussian = async (sample: "kitchen" | "venetian") => {
    let candidate: SplatMesh | null = null;
    setIngesting(true);
    setProgress(5);
    const isKitchen = sample === "kitchen";
    setNotice(`Opening the bundled AWS trained ${isKitchen ? "kitchen" : "Venetian Hall"} Gaussian`);
    try {
      const nextSplat = new SplatMesh({
        url: `${PUBLIC_BASE_PATH}/splats/${isKitchen ? "kitchen-island" : "venetian-hall-panos"}.sog`,
        lod: "quality",
        onProgress: (event) => setProgress(event.total ? Math.round(event.loaded / event.total * 100) : 40),
      });
      candidate = nextSplat;
      nextSplat.rotation.x = Math.PI;
      nextSplat.lodScale = THREE.MathUtils.lerp(0.55, 1.15, quality / 100);
      await activateGaussian(nextSplat, isKitchen ? "Kitchen Island · Trained Gaussian" : "Venetian Hall · Trained Gaussian", {
        label: "AWS Gaussian Splatting Toolbox sample",
        license: "MIT-0",
        url: "https://github.com/aws-solutions-library-samples/guidance-for-open-source-3d-reconstruction-toolbox-for-gaussian-splats-on-aws",
      });
      candidate = null;
    } catch (error) {
      candidate?.dispose();
      setNotice(error instanceof Error ? `Bundled Gaussian could not be opened: ${error.message}` : "Bundled Gaussian could not be opened");
    } finally {
      setIngesting(false);
    }
  };

  const ingestMedia = async (files: File[]) => {
    setIngesting(true);
    setNotice("Uploading capture to the configured reconstruction worker");
    try {
      const body = new FormData();
      files.forEach((file) => body.append("files", file));
      const response = await fetch(`${API_BASE}/api/ingest`, { method: "POST", body });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(detail.detail ?? `Reconstruction worker returned ${response.status}`);
      }
      const result = await response.json() as {
        scene_url?: string;
        quality?: { reconstruction_mode?: string };
      };
      if (!result.scene_url) throw new Error("Reconstruction worker did not return a scene URL");
      await loadProxyScene(result.scene_url);
      setNotice(
        result.quality?.reconstruction_mode === "surrogate-reconstruction"
          ? "CPU preview proxy loaded · import a trained SPZ for true Gaussian rendering"
          : "Capture processed and loaded from the configured worker",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `${error.message}. Hosted upload requires a configured local/GPU worker.`
          : "Hosted upload requires a configured local/GPU worker.",
      );
    } finally {
      setIngesting(false);
    }
  };

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    if (files.length === 1 && /\.(?:spz|sog)$/i.test(files[0].name)) await loadGaussianFile(files[0]);
    else await ingestMedia(files);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    await handleFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.tour = "off";
    setTour("off");
    runtime.dragging = true;
    runtime.moved = false;
    runtime.lastPointer = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime?.dragging) return;
    const dx = event.clientX - runtime.lastPointer.x;
    const dy = event.clientY - runtime.lastPointer.y;
    runtime.lastPointer = { x: event.clientX, y: event.clientY };
    if (Math.abs(dx) + Math.abs(dy) > 2) runtime.moved = true;
    runtime.yaw -= dx * 0.0048;
    runtime.pitch -= dy * 0.0042;
    if (runtime.sceneClass === "imported-gaussian" && runtime.navigation !== "walk") updateOrbitCamera(runtime);
    else updateLookCamera(runtime);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.dragging = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: React.WheelEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (runtime.sceneClass === "imported-gaussian" && runtime.navigation !== "walk") {
      runtime.distance += event.deltaY * 0.003;
      updateOrbitCamera(runtime);
    } else {
      const forward = new THREE.Vector3(Math.sin(runtime.yaw), 0, -Math.cos(runtime.yaw));
      runtime.walkPosition.addScaledVector(forward, -event.deltaY * 0.0006);
      runtime.walkPosition.clamp(runtime.safeMin, runtime.safeMax);
      updateLookCamera(runtime);
    }
  };

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("dgsi-theme", next);
  };

  return (
    <main className="capture-room">
      <header className="capture-header">
        <a className="capture-brand" href="#studio" aria-label="Spatial Capture Room home">
          <span>Spatial</span>
          <strong>Capture Room</strong>
        </a>
        <nav className="pipeline-stepper" aria-label="Reconstruction pipeline">
          {["Capture", "Register", "Optimize", "Review", "Publish"].map((step, index) => (
            <span key={step} className={index < 4 ? "complete" : index === 4 ? "current" : ""}>
              <i>{index + 1}</i>{step}
            </span>
          ))}
        </nav>
        <div className="capture-actions">
          <button type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <select
            aria-label="Built-in spatial example"
            value={exampleId}
            disabled={ingesting}
            onChange={(event) => {
              const next = event.target.value as ExampleId;
              if (next === "eso") void restoreEsoScene();
              else if (next === "kitchen" || next === "venetian") void loadBundledGaussian(next);
            }}
          >
            <option value="eso">ESO photo room</option>
            <option value="kitchen">AWS kitchen SOG</option>
            <option value="venetian">AWS Venetian Hall SOG</option>
            {exampleId === "custom" && <option value="custom">Current custom scene</option>}
          </select>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={ingesting}>
            {ingesting ? "Opening…" : "Add capture / splat"}
          </button>
          <input
            ref={fileRef}
            className="visually-hidden"
            type="file"
            multiple
            accept=".spz,.sog,image/*,video/*"
            onChange={onFileChange}
          />
        </div>
      </header>

      <section
        className={`spatial-stage mode-${mode} ${dropActive ? "drop-active" : ""}`}
        id="studio"
        aria-label="Interactive reconstructed scene"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { if (runtimeRef.current) runtimeRef.current.dragging = false; }}
        onWheel={onWheel}
        onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
        }}
        onDrop={async (event: ReactDragEvent<HTMLElement>) => {
          event.preventDefault();
          setDropActive(false);
          await handleFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div ref={mountRef} className="spatial-canvas" />
        <div className="stage-scrim" aria-hidden="true" />

        <div className="scene-heading">
          <p>
            {sceneOrigin === "eso"
              ? "REAL SPATIAL RECORD · VITACURA, CHILE"
              : sceneOrigin === "spz"
                ? "TRAINED GAUSSIAN · ANISOTROPIC SPLAT SCENE"
                : "LOCAL CAPTURE BATCH · GENERATED CPU PREVIEW"}
          </p>
          <h1>{sceneTitle}</h1>
          <div className={`classification ${classification.tone}`}>
            <i />
            <span><strong>{classification.label}</strong><small>{classification.detail}</small></span>
          </div>
        </div>

        <div className="runtime-readout" aria-label="Renderer status">
          <span>{fps} FPS</span>
          <i />
          <span>
            {sceneClass === "imported-gaussian"
              ? "SPARK / SPLAT"
              : sceneClass === "preview-proxy"
                ? "CPU PROXY"
                : "PHOTOGRAPHIC CONTEXT"}
          </span>
          <i />
          <span>{progress}% READY</span>
        </div>

        <nav className="view-modes" aria-label="Spatial view">
          {availableViewModes.map((item) => (
            <button key={item} className={mode === item ? "active" : ""} aria-pressed={mode === item} onClick={(event) => {
              event.stopPropagation();
              setActiveMode(item);
            }}>
              {VIEW_LABELS[item]}
            </button>
          ))}
        </nav>

        <div className="camera-tools" aria-label="Camera controls">
          <button type="button" className={navigation === "walk" ? "active" : ""} aria-pressed={navigation === "walk"} onClick={(event) => {
            event.stopPropagation();
            const next = navigation === "walk" ? "look" : "walk";
            if (next === "walk") {
              if (runtimeRef.current) runtimeRef.current.tour = "off";
              setTour("off");
            }
            setNavigation(next);
            setNotice(next === "walk" ? "Walk mode · WASD / arrows · Shift to move faster" : "Look mode · drag to look · wheel to dolly");
          }}>Walk</button>
          <button type="button" className={tour === "path" ? "active" : ""} onClick={(event) => { event.stopPropagation(); startTour("path"); }}>Tour</button>
          <button type="button" className={tour === "look" ? "active" : ""} onClick={(event) => { event.stopPropagation(); startTour("look"); }}>360°</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); resetCamera(); }}>Reset</button>
        </div>

        <button className="inspector-trigger" type="button" aria-expanded={inspectorOpen} onClick={(event) => {
          event.stopPropagation();
          setInspectorOpen((open) => !open);
        }}>
          {inspectorOpen ? "Close details" : "Scene details"}
        </button>

        {sceneOrigin === "eso" && mode === "source" && (
          <section className="source-match" aria-label="Source comparison">
            <div>
              <span>OBSERVED SOURCE · VIEW {String(selectedSource + 1).padStart(2, "0")}</span>
              <Image
                src={`${PUBLIC_BASE_PATH}/room-inputs/room-${String(selectedSource).padStart(2, "0")}.jpg`}
                fill
                sizes="50vw"
                unoptimized
                alt={`Observed ESO guesthouse source direction ${selectedSource + 1}`}
              />
            </div>
            <div className="live-half"><span>ACTIVE SPATIAL VIEW</span></div>
          </section>
        )}

        {sceneOrigin === "eso" && mode === "coverage" && (
          <section className="coverage-map" aria-label="Capture coverage">
            <div className="coverage-orbit">
              <i className="safe-hull" />
              {SOURCE_VIEWS.map((view, index) => (
                <i
                  key={view}
                  className="camera-ray"
                  style={{ transform: `rotate(${index * 30}deg) translateY(-74px)` }}
                />
              ))}
              <b>SAFE<br />HULL</b>
            </div>
            <div>
              <span>12 / 12 source directions</span>
              <strong>Complete rotational coverage</strong>
              <p>Movement remains inside the declared safe hull. This hosted example is a single 360° photographic capture, not recovered metric geometry.</p>
            </div>
          </section>
        )}

        {inspectorOpen && (
          <aside className="scene-inspector" onPointerDown={(event) => event.stopPropagation()}>
            <header><span>Scene record</span><button type="button" onClick={() => setInspectorOpen(false)} aria-label="Close scene details">×</button></header>
            <dl>
              <div><dt>Classification</dt><dd>{classification.label}</dd></div>
              <div>
                <dt>Source</dt>
                <dd>
                  {sceneOrigin === "eso"
                    ? "ESO · gh-livingroom-pan"
                    : sceneOrigin === "spz"
                      ? trainedSource?.label ?? "Local file · metadata not embedded"
                      : `${manifest?.source.file_count ?? 0} uploaded capture files`}
                </dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>{sceneOrigin === "eso" ? "CC BY 4.0" : trainedSource?.license ?? "User supplied"}</dd>
              </div>
              <div>
                <dt>Projection</dt>
                <dd>
                  {sceneOrigin === "spz"
                    ? "Anisotropic 3D Gaussians"
                    : manifest?.environment?.projection === "equirectangular"
                      ? "Equirectangular · 360°"
                      : "Source mosaic context"}
                </dd>
              </div>
              <div>
                <dt>{sceneOrigin === "spz" ? "Renderer" : "Proxy points"}</dt>
                <dd>{sceneOrigin === "spz" ? "Spark 2.1 · local decode" : manifest?.point_count.toLocaleString() ?? "108,656"}</dd>
              </div>
            </dl>
            {sceneOrigin !== "spz" && (
              <label className="inspector-toggle">
                <span><strong>Observed context</strong><small>Prevents unsupported black regions</small></span>
                <input type="checkbox" checked={contextEnabled} onChange={() => setContextEnabled((enabled) => !enabled)} />
              </label>
            )}
            <label>
              <span>Render budget <output>{quality}%</output></span>
              <input aria-label="Rendering budget" type="range" min="40" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
            </label>
            <label>
              <span>Exposure <output>{(exposure / 100).toFixed(2)}×</output></span>
              <input aria-label="Exposure" type="range" min="70" max="130" value={exposure} onChange={(event) => setExposure(Number(event.target.value))} />
            </label>
            <div className="exposure-presets">
              {([["Soft", 86], ["Observed", 100], ["Bright", 116]] as const).map(([label, value]) => (
                <button key={label} type="button" className={exposure === value ? "active" : ""} onClick={() => setExposure(value)}>{label}</button>
              ))}
            </div>
            {sceneOrigin === "eso" && (
              <a href="https://commons.wikimedia.org/wiki/File:Guesthouse_living_room_(gh-livingroom-pan).jpg" target="_blank" rel="noreferrer">
                View original and license ↗
              </a>
            )}
            {sceneOrigin === "spz" && trainedSource?.url && (
              <a href={trainedSource.url} target="_blank" rel="noreferrer">
                View trained sample source and license ↗
              </a>
            )}
          </aside>
        )}

        {dropActive && <div className="capture-drop"><strong>Drop capture media or a trained SPZ</strong><span>SPZ opens locally. Images and videos require the configured reconstruction worker.</span></div>}
        {progress < 100 && <div className="capture-progress"><span>Opening spatial record</span><b>{progress}%</b><i><em style={{ width: `${progress}%` }} /></i></div>}
        <div className="stage-notice" role="status" aria-live="polite">{notice}</div>
      </section>

      {sceneOrigin === "eso" && (
      <section className={`capture-filmstrip ${filmstripOpen ? "open" : ""}`} aria-label="Observed source views">
        <button type="button" className="filmstrip-label" aria-expanded={filmstripOpen} onClick={() => setFilmstripOpen((open) => !open)}>
          <span>Observed source</span>
          <strong>{filmstripOpen ? "Hide views" : "Show 12 views"}</strong>
        </button>
        {filmstripOpen && (
          <>
            <div className="filmstrip-track">
              {SOURCE_VIEWS.map((_, index) => (
                <button type="button" key={index} className={selectedSource === index ? "active" : ""} onClick={() => {
                  setSelectedSource(index);
                  const runtime = runtimeRef.current;
                  if (runtime) {
                    runtime.tour = "off";
                    setTour("off");
                    runtime.yaw = THREE.MathUtils.degToRad(index * 30);
                    runtime.pitch = 0;
                    updateLookCamera(runtime);
                  }
                  if (mode === "source") setNotice(`Observed source view ${index + 1} selected`);
                }}>
                  <Image
                    src={`${PUBLIC_BASE_PATH}/room-inputs/room-${String(index).padStart(2, "0")}.jpg`}
                    width={190}
                    height={122}
                    unoptimized
                    alt={`Observed ESO guesthouse view ${index + 1}`}
                  />
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </button>
              ))}
            </div>
            <div className="filmstrip-meta">
              <span>12 rectilinear views derived from one observed 360° photograph</span>
              <a href="https://www.eso.org/public/images/gh-livingroom-pan/" target="_blank" rel="noreferrer">ESO source ↗</a>
            </div>
          </>
        )}
      </section>
      )}
    </main>
  );
}
