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
import { dampedCameraValue, lookAroundYaw, normalizedTourProgress } from "./spatial-motion";

type Theme = "dark" | "light";
type ViewMode = "explore" | "source" | "coverage" | "inspect";
type Navigation = "look" | "walk";
type SceneClass = "panorama-context" | "preview-proxy" | "imported-gaussian";
type SceneOrigin = "eso" | "generated" | "spz";
type ExampleId = "eso" | "kitchen" | "custom";

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
  desiredYaw: number;
  desiredPitch: number;
  walkPosition: THREE.Vector3;
  entryPosition: THREE.Vector3;
  safeMin: THREE.Vector3;
  safeMax: THREE.Vector3;
  moveSpeed: number;
  canTranslate: boolean;
  reducedMotion: boolean;
  navigation: Navigation;
  sceneClass: SceneClass;
  dragging: boolean;
  moved: boolean;
  lastPointer: { x: number; y: number };
  keys: Set<string>;
  tour: "off" | "look";
  tourBaseYaw: number;
  tourStart: number;
  tourDuration: number;
  lastTime: number;
  scratchDirection: THREE.Vector3;
  scratchForward: THREE.Vector3;
  scratchRight: THREE.Vector3;
  scratchMove: THREE.Vector3;
};

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const DEFAULT_MANIFEST = `${PUBLIC_BASE_PATH}/room-demo/manifest.json`;
const CONTEXT_4K_URL = `${PUBLIC_BASE_PATH}/captures/eso-guesthouse/context-webgl.jpg`;
const CONTEXT_8K_URL = `${PUBLIC_BASE_PATH}/captures/eso-guesthouse/context-8k.jpg`;
const API_BASE = process.env.NEXT_PUBLIC_DGSI_API_URL ?? "http://127.0.0.1:8016";
const SOURCE_VIEWS = ["000", "030", "060", "090", "120", "150", "180", "210", "240", "270", "300", "330"];
const MAX_LOOK_PITCH = THREE.MathUtils.degToRad(89);

function contextUrlForRenderer(renderer: THREE.WebGLRenderer) {
  const supports8K =
    renderer.capabilities.maxTextureSize >= 8192 &&
    window.innerWidth >= 900 &&
    !window.matchMedia("(pointer: coarse)").matches;
  return supports8K ? CONTEXT_8K_URL : CONTEXT_4K_URL;
}

const VIEW_LABELS: Record<ViewMode, string> = {
  explore: "Explore",
  source: "Source match",
  coverage: "Coverage",
  inspect: "Point proxy",
};

function updateLookCamera(runtime: Runtime) {
  runtime.pitch = THREE.MathUtils.clamp(runtime.pitch, -MAX_LOOK_PITCH, MAX_LOOK_PITCH);
  const direction = runtime.scratchDirection.set(
    Math.sin(runtime.yaw) * Math.cos(runtime.pitch),
    Math.sin(runtime.pitch),
    -Math.cos(runtime.yaw) * Math.cos(runtime.pitch),
  );
  runtime.camera.position.copy(runtime.walkPosition);
  runtime.scratchMove.copy(runtime.walkPosition).add(direction);
  runtime.camera.lookAt(runtime.scratchMove);
}

function settleCamera(runtime: Runtime, delta: number, immediate = false) {
  runtime.yaw = immediate || runtime.reducedMotion
    ? runtime.desiredYaw
    : dampedCameraValue(runtime.yaw, runtime.desiredYaw, 18, delta);
  runtime.pitch = immediate || runtime.reducedMotion
    ? runtime.desiredPitch
    : dampedCameraValue(runtime.pitch, runtime.desiredPitch, 18, delta);
  updateLookCamera(runtime);
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
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [mode, setMode] = useState<ViewMode>("explore");
  const [navigation, setNavigation] = useState<Navigation>("look");
  const [canWalk, setCanWalk] = useState(true);
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
  const [tour, setTour] = useState<"off" | "look">("off");
  const [renderProfile, setRenderProfile] = useState("Preparing");
  const [exposure, setExposure] = useState(100);
  const [ingesting, setIngesting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

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
    : ["explore"];

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    window.requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
  }, []);

  const resetCamera = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.tour = "off";
    setTour("off");
    runtime.yaw = 0;
    runtime.pitch = 0;
    runtime.desiredYaw = 0;
    runtime.desiredPitch = 0;
    runtime.walkPosition.copy(runtime.entryPosition);
    runtime.camera.fov =
      runtime.sceneClass === "imported-gaussian" ? 68 : 54;
    runtime.camera.updateProjectionMatrix();
    settleCamera(runtime, 0, true);
    setNavigation("look");
    setNotice(
      runtime.canTranslate
        ? "View reset inside the registered capture volume"
        : "View reset to the conservative import origin · rotate-only",
    );
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
      else setNotice(runtime.sceneClass === "imported-gaussian" ? "Imported Gaussian scene · SPZ/SOG data" : "Real 360° photographic context · not trained 3DGS");
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

    const spark = new SparkRenderer({
      renderer,
      sortRadial: true,
      minSortIntervalMs: 0,
      preBlurAmount: 0,
      blurAmount: 0,
      focalAdjustment: 1.35,
      lodSplatScale: 1.4,
    });
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

    const runtime: Runtime = {
      renderer, scene, camera, spark, splat: null, splatUrl: null,
      proxy, proxyGeometry, environment, environmentTexture: null,
      yaw: 0, pitch: 0, desiredYaw: 0, desiredPitch: 0,
      walkPosition: new THREE.Vector3(), entryPosition: new THREE.Vector3(),
      safeMin: new THREE.Vector3(-0.42, -0.18, -0.54),
      safeMax: new THREE.Vector3(0.42, 0.18, 0.24), moveSpeed: 0.42,
      canTranslate: true, reducedMotion: false, navigation: "look",
      sceneClass: "panorama-context", dragging: false, moved: false,
      lastPointer: { x: 0, y: 0 }, keys: new Set(), tour: "off",
      tourBaseYaw: 0, tourStart: 0, tourDuration: 12000, lastTime: performance.now(),
      scratchDirection: new THREE.Vector3(), scratchForward: new THREE.Vector3(),
      scratchRight: new THREE.Vector3(), scratchMove: new THREE.Vector3(),
    };
    runtimeRef.current = runtime;
    updateLookCamera(runtime);

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      camera.aspect = rect.width / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    const selectedContextUrl = contextUrlForRenderer(renderer);
    setRenderProfile(selectedContextUrl === CONTEXT_8K_URL ? "8K / 360×180" : "4K / 360×180");
    new THREE.TextureLoader().load(
      selectedContextUrl,
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
        runtime.environment.visible = runtime.sceneClass === "panorama-context";
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
      runtime.walkPosition
        .fromArray(checked.spatial.entry_pose.position)
        .clamp(runtime.safeMin, runtime.safeMax);
      runtime.entryPosition.copy(runtime.walkPosition);
      runtime.moveSpeed = Math.max(
        0.28,
        runtime.safeMax.clone().sub(runtime.safeMin).length() * 0.28,
      );
      settleCamera(runtime, 0, true);
    }).catch(() => {
      if (!controller.signal.aborted) setNotice("Photographic context ready · proxy inspection unavailable");
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) return;
      if ((event.target as HTMLElement | null)?.matches("input, button, select, textarea")) return;
      if (!mount.parentElement?.contains(document.activeElement)) return;
      if (
        runtime.navigation === "look" &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)
      ) {
        const lookStep = THREE.MathUtils.degToRad(event.shiftKey ? 7 : 3);
        if (event.code === "ArrowLeft") runtime.desiredYaw += lookStep;
        if (event.code === "ArrowRight") runtime.desiredYaw -= lookStep;
        if (event.code === "ArrowUp") {
          runtime.desiredPitch = Math.min(MAX_LOOK_PITCH, runtime.desiredPitch + lookStep);
        }
        if (event.code === "ArrowDown") {
          runtime.desiredPitch = Math.max(-MAX_LOOK_PITCH, runtime.desiredPitch - lookStep);
        }
        event.preventDefault();
        return;
      }
      runtime.keys.add(event.code);
      if (runtime.navigation === "walk") event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => runtime.keys.delete(event.code);
    const onBlur = () => runtime.keys.clear();
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionPreference = (event: MediaQueryListEvent | MediaQueryList) => {
      runtime.reducedMotion = event.matches;
      if (event.matches && runtime.tour === "look") {
        runtime.tour = "off";
        setTour("off");
      }
      setReducedMotion(event.matches);
    };
    onMotionPreference(motionPreference);
    motionPreference.addEventListener("change", onMotionPreference);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    let frames = 0;
    let fpsStart = performance.now();
    renderer.setAnimationLoop((now) => {
      const delta = Math.min(0.05, Math.max(0, (now - runtime.lastTime) / 1000));
      runtime.lastTime = now;
      if (runtime.tour === "look") {
        const elapsed = normalizedTourProgress(now, runtime.tourStart, runtime.tourDuration);
        if (elapsed >= 1) {
          runtime.yaw = runtime.tourBaseYaw + Math.PI * 2;
          runtime.desiredYaw = runtime.yaw;
          runtime.tour = "off";
          setTour("off");
        } else {
          runtime.yaw = runtime.tourBaseYaw + lookAroundYaw(elapsed);
          runtime.desiredYaw = runtime.yaw;
        }
        updateLookCamera(runtime);
      } else {
        // Direct pointer tracking prevents a trailing, soft-looking view while
        // the splat sorter is updating. Keyboard look keeps the eased path.
        settleCamera(runtime, delta, runtime.dragging);
      }
      if (runtime.navigation === "walk" && runtime.keys.size) {
        const boost = runtime.keys.has("ShiftLeft") || runtime.keys.has("ShiftRight") ? 2.4 : 1;
        const forward = runtime.scratchForward.set(Math.sin(runtime.yaw), 0, -Math.cos(runtime.yaw));
        const right = runtime.scratchRight.set(Math.cos(runtime.yaw), 0, Math.sin(runtime.yaw));
        const move = runtime.scratchMove.set(0, 0, 0);
        if (runtime.keys.has("KeyW") || runtime.keys.has("ArrowUp")) move.add(forward);
        if (runtime.keys.has("KeyS") || runtime.keys.has("ArrowDown")) move.sub(forward);
        if (runtime.keys.has("KeyD") || runtime.keys.has("ArrowRight")) move.add(right);
        if (runtime.keys.has("KeyA") || runtime.keys.has("ArrowLeft")) move.sub(right);
        if (move.lengthSq()) {
          runtime.walkPosition.add(move.normalize().multiplyScalar(delta * runtime.moveSpeed * boost));
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
      motionPreference.removeEventListener("change", onMotionPreference);
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
    if (!runtime) return;
    runtime.environment.visible =
      runtime.sceneClass !== "imported-gaussian" &&
      contextEnabled &&
      mode !== "inspect" &&
      Boolean(runtime.environmentTexture);
  }, [contextEnabled, mode]);

  const startLookAround = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (reducedMotion) {
      setNotice("Automatic camera motion is paused by your reduced-motion preference");
      return;
    }
    runtime.tour = "look";
    runtime.tourBaseYaw = runtime.yaw;
    runtime.tourStart = performance.now();
    runtime.tourDuration = 14000;
    runtime.pitch = 0;
    runtime.desiredPitch = 0;
    setTour("look");
    setNavigation("look");
    setMode("explore");
    setSceneClass(runtime.sceneClass);
    runtime.proxy.visible = false;
    runtime.environment.visible =
      runtime.sceneClass !== "imported-gaussian" &&
      contextEnabled &&
      Boolean(runtime.environmentTexture);
    setNotice("Stable full-resolution 360° look-around · one continuous revolution");
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
        ? contextUrlForRenderer(runtime.renderer)
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
    runtime.moveSpeed = Math.max(
      0.28,
      runtime.safeMax.clone().sub(runtime.safeMin).length() * 0.28,
    );
    runtime.walkPosition.fromArray(checked.spatial.entry_pose.position).clamp(runtime.safeMin, runtime.safeMax);
    runtime.entryPosition.copy(runtime.walkPosition);
    runtime.canTranslate = checked.spatial.navigable;
    if (!runtime.canTranslate) {
      runtime.safeMin.copy(runtime.entryPosition);
      runtime.safeMax.copy(runtime.entryPosition);
    }
    runtime.yaw = 0;
    runtime.pitch = 0;
    runtime.desiredYaw = 0;
    runtime.desiredPitch = 0;
    runtime.tour = "off";
    setTour("off");
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
    setCanWalk(runtime.canTranslate);
    setProgress(100);
    setRenderProfile(
      origin === "eso" && contextUrlForRenderer(runtime.renderer) === CONTEXT_8K_URL
        ? "8K / 360×180"
        : origin === "eso"
          ? "4K / 360×180"
          : "CPU preview",
    );
    settleCamera(runtime, 0, true);
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
    nextSplat.updateMatrixWorld(true);
    const bounds = nextSplat.getBoundingBox(true).applyMatrix4(nextSplat.matrixWorld);
    const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    const size = bounds.isEmpty() ? new THREE.Vector3(3, 3, 3) : bounds.getSize(new THREE.Vector3());
    const radius = Math.max(0.5, size.length() * 0.5);
    const splatCount = nextSplat.splats?.getNumSplats() ?? 0;
    const isBundledKitchen =
      source.label.startsWith("AWS") && title.startsWith("Kitchen");
    // Trained 3DGS scenes are commonly normalized around the capture-camera
    // volume. The geometric bounds center can lie inside a wall, table, or dense
    // foreground cluster, which turns nearby splats into a blurred screen-filling
    // veil. Prefer the registered origin whenever it falls inside the scene hull;
    // only fall back to the bounds center for translated imports.
    const registeredOrigin = new THREE.Vector3();
    const entry = !bounds.isEmpty() && bounds.containsPoint(registeredOrigin)
      ? registeredOrigin
      : center;
    const previousSplat = runtime.splat;
    runtime.scene.add(nextSplat);
    runtime.splat = nextSplat;
    if (previousSplat) {
      runtime.scene.remove(previousSplat);
      previousSplat.dispose();
    }
    runtime.sceneClass = "imported-gaussian";
    runtime.scene.background = new THREE.Color(
      isBundledKitchen
        ? "#c8c2b9"
        : "#24211f",
    );
    setSceneClass("imported-gaussian");
    setSceneOrigin("spz");
    setExampleId(
      isBundledKitchen
        ? "kitchen"
        : "custom",
    );
    setSceneTitle(title);
    setTrainedSource(source);
    setManifest(null);
    runtime.proxy.visible = false;
    runtime.environment.visible = false;
    setContextEnabled(false);
    runtime.entryPosition.copy(entry);
    runtime.canTranslate = isBundledKitchen;
    if (isBundledKitchen) {
      // The bundled sample is manually checked around its origin. Keep movement
      // intentionally local so the camera cannot enter unsupported splat space.
      const horizontal = Math.max(0.08, Math.min(0.32, radius * 0.055));
      runtime.safeMin.copy(entry).add(new THREE.Vector3(-horizontal, -horizontal * 0.28, -horizontal));
      runtime.safeMax.copy(entry).add(new THREE.Vector3(horizontal, horizontal * 0.28, horizontal));
    } else {
      // SPZ/SOG does not carry a standard camera path or walkable hull. Unknown
      // imports therefore open at a conservative pose with rotate-only controls.
      runtime.safeMin.copy(entry);
      runtime.safeMax.copy(entry);
    }
    runtime.walkPosition.copy(runtime.entryPosition);
    runtime.moveSpeed = Math.max(0.35, radius * 0.12);
    runtime.yaw = 0;
    runtime.pitch = 0;
    runtime.desiredYaw = 0;
    runtime.desiredPitch = 0;
    runtime.tour = "off";
    setTour("off");
    runtime.camera.near = Math.max(0.01, radius / 1000);
    runtime.camera.far = Math.max(120, radius * 20);
    runtime.camera.fov = 68;
    runtime.camera.updateProjectionMatrix();
    settleCamera(runtime, 0, true);
    setProgress(100);
    setMode("explore");
    setNavigation("look");
    setCanWalk(runtime.canTranslate);
    setRenderProfile(
      splatCount > 0
        ? `${Math.round(splatCount / 1000).toLocaleString()}K full splats`
        : "Full-splat detail",
    );
    setNotice(
      isBundledKitchen
        ? "Trained Gaussian ready · curated local movement hull · full-splat detail"
        : "Trained Gaussian ready · rotate-only until a registered camera hull is supplied",
    );
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
        nonLod: true,
        onProgress: (event) => setProgress(event.total ? Math.round(event.loaded / event.total * 100) : 40),
      });
      candidate = nextSplat;
      await nextSplat.initialized;
      nextSplat.enableLod = (nextSplat.splats?.getNumSplats() ?? 0) > 1_500_000;
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

  const loadBundledGaussian = async () => {
    let candidate: SplatMesh | null = null;
    setIngesting(true);
    setProgress(5);
    setNotice("Opening the bundled AWS trained kitchen Gaussian");
    try {
      const nextSplat = new SplatMesh({
        url: `${PUBLIC_BASE_PATH}/splats/kitchen-island.sog`,
        enableLod: false,
        onProgress: (event) => setProgress(event.total ? Math.round(event.loaded / event.total * 100) : 40),
      });
      candidate = nextSplat;
      nextSplat.rotation.x = Math.PI;
      await activateGaussian(nextSplat, "Kitchen Island · Trained Gaussian", {
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
          ? "Non-metric CPU review proxy loaded · rotate-only · import a trained SPZ for true Gaussian rendering"
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
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, summary, [role='dialog']")) return;
    event.currentTarget.focus({ preventScroll: true });
    runtime.tour = "off";
    setTour("off");
    runtime.dragging = true;
    runtime.moved = false;
    runtime.desiredYaw = runtime.yaw;
    runtime.desiredPitch = runtime.pitch;
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
    runtime.desiredYaw -= dx * 0.0034;
    runtime.desiredPitch = THREE.MathUtils.clamp(
      runtime.desiredPitch - dy * 0.0032,
      -MAX_LOOK_PITCH,
      MAX_LOOK_PITCH,
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.dragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (runtime) runtime.dragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime?.canTranslate) return;
    const direction = runtime.scratchDirection.set(
      Math.sin(runtime.yaw) * Math.cos(runtime.pitch),
      Math.sin(runtime.pitch),
      -Math.cos(runtime.yaw) * Math.cos(runtime.pitch),
    );
    runtime.walkPosition.addScaledVector(direction, -event.deltaY * runtime.moveSpeed * 0.0014);
    runtime.walkPosition.clamp(runtime.safeMin, runtime.safeMax);
    updateLookCamera(runtime);
  };

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("dgsi-theme", next);
  };

  return (
    <main className="capture-room">
      <p id="camera-instructions" className="visually-hidden">
        Drag to look around. In look mode, use the arrow keys to rotate. In walk mode,
        use W A S D or the arrow keys to move and hold Shift to move faster.
      </p>
      {!canWalk && (
        <p id="translation-lock-note" className="visually-hidden">
          This scene has no registered safe camera hull, so translation is locked and rotation remains available.
        </p>
      )}
      <header className="capture-header">
        <a className="capture-brand" href="#studio" aria-label="Spatial Capture Room home">
          <span>Spatial viewer</span>
          <strong>Capture Room</strong>
        </a>
        <div className="scene-picker">
          <span>Scene</span>
          <select
            aria-label="Built-in spatial example"
            value={exampleId}
            disabled={ingesting}
            onChange={(event) => {
              const next = event.target.value as ExampleId;
              if (next === "eso") void restoreEsoScene();
              else if (next === "kitchen") void loadBundledGaussian();
            }}
          >
            <option value="eso">ESO photo room</option>
            <option value="kitchen">AWS kitchen SOG</option>
            {exampleId === "custom" && <option value="custom">Current custom scene</option>}
          </select>
          <i aria-label={`Rendering profile: ${renderProfile}`}>{renderProfile}</i>
        </div>
        <div className="capture-actions">
          <button type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={ingesting}>
            {ingesting ? "Opening…" : "Open capture"}
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
        aria-label="Interactive spatial scene"
        aria-describedby={`camera-instructions${canWalk ? "" : " translation-lock-note"}`}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight W A S D"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={() => { if (runtimeRef.current) runtimeRef.current.dragging = false; }}
        onBlur={() => {
          runtimeRef.current?.keys.clear();
          if (runtimeRef.current) runtimeRef.current.dragging = false;
        }}
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
                : "LOCAL CAPTURE BATCH · NON-METRIC CPU REVIEW PROXY"}
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
              ? renderProfile
              : sceneClass === "preview-proxy"
                ? "CPU PROXY"
                : renderProfile}
          </span>
          <i />
          <span>{progress}% READY</span>
        </div>

        {availableViewModes.length > 1 && (
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
        )}

        <div className="camera-tools" role="group" aria-label="Camera controls">
          {canWalk ? (
            <button type="button" className={navigation === "walk" ? "active" : ""} aria-pressed={navigation === "walk"} onClick={(event) => {
              event.stopPropagation();
              const next = navigation === "walk" ? "look" : "walk";
              if (next === "walk") {
                if (runtimeRef.current) runtimeRef.current.tour = "off";
                setTour("off");
              }
              setNavigation(next);
              setNotice(next === "walk" ? "Walk mode · WASD / arrows · Shift to move faster" : "Look mode · drag or use arrow keys to look");
            }}>Walk</button>
          ) : (
            <span className="camera-constraint" aria-describedby="translation-lock-note">Rotate only</span>
          )}
          <button
            type="button"
            className={tour === "look" ? "active" : ""}
            disabled={reducedMotion}
            aria-describedby={reducedMotion ? "reduced-motion-note" : undefined}
            onClick={(event) => { event.stopPropagation(); startLookAround(); }}
          >
            Auto look
          </button>
          {reducedMotion && (
            <span id="reduced-motion-note" className="visually-hidden">
              Automatic camera movement is unavailable while reduced motion is enabled.
            </span>
          )}
          <button type="button" onClick={(event) => { event.stopPropagation(); resetCamera(); }}>Reset</button>
        </div>

        <button
          ref={inspectorTriggerRef}
          className="inspector-trigger"
          type="button"
          aria-expanded={inspectorOpen}
          aria-controls="scene-inspector"
          onClick={(event) => {
          event.stopPropagation();
          setInspectorOpen((open) => !open);
          }}
        >
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
          <aside
            id="scene-inspector"
            className="scene-inspector"
            aria-label="Scene details"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeInspector();
              }
            }}
          >
            <header><span>Scene record</span><button type="button" onClick={closeInspector} aria-label="Close scene details">×</button></header>
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

        {dropActive && <div className="capture-drop"><strong>Drop capture media or a trained SPZ/SOG</strong><span>SPZ/SOG opens locally. Images and videos require the configured reconstruction worker.</span></div>}
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
                        runtime.desiredYaw = runtime.yaw;
                        runtime.desiredPitch = 0;
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
