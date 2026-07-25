"use client";

import {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { decodeDgsi, SceneManifest, validateManifest } from "./scene-format";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  material: THREE.ShaderMaterial;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  pointCount: number;
  semantic: Float32Array;
  positions: Float32Array;
  target: THREE.Vector3;
  yaw: number;
  pitch: number;
  distance: number;
  dragging: boolean;
  dragMoved: boolean;
  lastPointer: { x: number; y: number };
  cameraPathEnabled: boolean;
  cameraPathFrames: SceneManifest["camera_path"];
  navigation: "orbit" | "walk";
  walkPosition: THREE.Vector3;
  entryPosition: THREE.Vector3;
  entryTarget: THREE.Vector3;
  boundsMin: THREE.Vector3;
  boundsMax: THREE.Vector3;
  keys: Set<string>;
  timeline: number;
  lastFrameTime: number;
};

const DEFAULT_MANIFEST = "/demo/manifest.json";
const API_BASE = process.env.NEXT_PUBLIC_DGSI_API_URL ?? "http://127.0.0.1:8016";

const vertexShader = `
  attribute float aScale;
  attribute float aSemantic;
  attribute float aPhase;
  attribute float aChange;
  attribute float aOpacity;
  uniform float uTimeline;
  uniform float uPointScale;
  uniform float uSelected;
  uniform float uHeatmap;
  uniform vec4 uVisibility;
  uniform float uVisible4;
  varying vec3 vColor;
  varying float vOpacity;
  varying float vHeat;
  varying float vDepth;

  void main() {
    vec3 p = position;
    if (aSemantic > 1.5 && aSemantic < 2.5) {
      p.x += sin(uTimeline * 6.28318 + aPhase) * 0.18;
      p.z += cos(uTimeline * 6.28318 + aPhase) * 0.08;
    }
    float visible = 1.0;
    if (aSemantic < 0.5) visible = uVisibility.x;
    else if (aSemantic < 1.5) visible = uVisibility.y;
    else if (aSemantic < 2.5) visible = uVisibility.z;
    else if (aSemantic < 3.5) visible = uVisibility.w;
    else visible = uVisible4;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aScale * uPointScale * (18.0 / max(0.4, -mvPosition.z)), 0.9, 10.0);
    vColor = color;
    if (uSelected > -0.5 && abs(aSemantic - uSelected) > 0.4) {
      vColor *= 0.22;
      vOpacity = aOpacity * 0.2 * visible;
    } else {
      vOpacity = aOpacity * visible;
    }
    vHeat = aChange * uHeatmap;
    vDepth = max(0.0, -mvPosition.z);
  }
`;

const fragmentShader = `
  uniform float uExposure;
  varying vec3 vColor;
  varying float vOpacity;
  varying float vHeat;
  varying float vDepth;
  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float radius = dot(centered, centered);
    if (radius > 0.25) discard;
    float gaussian = exp(-radius * 11.0);
    vec3 heat = mix(vec3(0.18, 0.42, 1.0), vec3(1.0, 0.14, 0.05), smoothstep(0.05, 1.0, vHeat));
    vec3 color = mix(vColor, heat, clamp(vHeat * 0.92, 0.0, 0.92)) * uExposure;
    float haze = smoothstep(7.0, 18.0, vDepth);
    color = mix(color, vec3(0.02, 0.035, 0.029), haze * 0.58);
    gl_FragColor = vec4(color, gaussian * vOpacity * (1.0 - haze * 0.28));
  }
`;

function formatPoints(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function resolveSceneUrl(manifestUrl: string, binaryUrl: string) {
  return new URL(binaryUrl, new URL(manifestUrl, window.location.href)).toString();
}

function vector(values: [number, number, number]) {
  return new THREE.Vector3(values[0], values[1], values[2]);
}

function directionAngles(position: THREE.Vector3, target: THREE.Vector3) {
  const direction = target.clone().sub(position).normalize();
  return {
    yaw: Math.atan2(direction.x, -direction.z),
    pitch: Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)),
  };
}

export function SceneStudio() {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraReadoutRef = useRef<HTMLSpanElement>(null);
  const loadRequestRef = useRef<AbortController | null>(null);
  const qualityRef = useRef(82);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [status, setStatus] = useState("Opening packaged scene");
  const [playing, setPlaying] = useState(true);
  const [timeline, setTimeline] = useState(42);
  const [selected, setSelected] = useState<number | null>(null);
  const [heatmap, setHeatmap] = useState(false);
  const [quality, setQuality] = useState(82);
  const [exposure, setExposure] = useState(105);
  const [cameraPath, setCameraPath] = useState(false);
  const [visible, setVisible] = useState([true, true, true, true, true]);
  const [fps, setFps] = useState(60);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([]);
  const [xrLabel, setXrLabel] = useState("Enter spatial view");
  const [notice, setNotice] = useState("Drag to orbit · Scroll to dolly · Click a splat to inspect");
  const [ingesting, setIngesting] = useState(false);
  const [semanticCounts, setSemanticCounts] = useState<number[]>([]);
  const [changedCount, setChangedCount] = useState(0);
  const [meanChange, setMeanChange] = useState(0);
  const [uncertainCount, setUncertainCount] = useState(0);
  const [activeManifestUrl, setActiveManifestUrl] = useState(DEFAULT_MANIFEST);
  const [navigation, setNavigation] = useState<"orbit" | "walk">("orbit");
  const [dropActive, setDropActive] = useState(false);

  const updateOrbitCamera = useCallback((runtime: Runtime) => {
    runtime.pitch = THREE.MathUtils.clamp(runtime.pitch, -1.15, 1.15);
    runtime.distance = THREE.MathUtils.clamp(runtime.distance, 1.8, 24);
    const cp = Math.cos(runtime.pitch);
    runtime.camera.position.set(
      runtime.target.x + Math.sin(runtime.yaw) * cp * runtime.distance,
      runtime.target.y + Math.sin(runtime.pitch) * runtime.distance,
      runtime.target.z + Math.cos(runtime.yaw) * cp * runtime.distance,
    );
    runtime.camera.lookAt(runtime.target);
  }, []);

  const updateWalkCamera = useCallback((runtime: Runtime) => {
    runtime.pitch = THREE.MathUtils.clamp(runtime.pitch, -1.35, 1.35);
    runtime.walkPosition.clamp(runtime.boundsMin, runtime.boundsMax);
    const direction = new THREE.Vector3(
      Math.sin(runtime.yaw) * Math.cos(runtime.pitch),
      Math.sin(runtime.pitch),
      -Math.cos(runtime.yaw) * Math.cos(runtime.pitch),
    );
    runtime.camera.position.copy(runtime.walkPosition);
    runtime.target.copy(runtime.walkPosition).add(direction);
    runtime.camera.lookAt(runtime.target);
    if (cameraReadoutRef.current) {
      const { x, y, z } = runtime.walkPosition;
      cameraReadoutRef.current.textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)} · Z ${z.toFixed(2)} su`;
    }
  }, []);

  const applyCameraPath = useCallback((runtime: Runtime) => {
    const frames = runtime.cameraPathFrames;
    if (frames.length < 2) return;
    const time = THREE.MathUtils.clamp(runtime.timeline, 0, 1);
    let upper = frames.findIndex((frame) => frame.time >= time);
    if (upper <= 0) upper = 1;
    const start = frames[upper - 1];
    const end = frames[Math.min(upper, frames.length - 1)];
    const span = Math.max(1e-6, end.time - start.time);
    const alpha = THREE.MathUtils.clamp((time - start.time) / span, 0, 1);
    runtime.camera.position.lerpVectors(vector(start.position), vector(end.position), alpha);
    runtime.target.lerpVectors(vector(start.target), vector(end.target), alpha);
    runtime.camera.fov = THREE.MathUtils.lerp(start.fov, end.fov, alpha);
    runtime.camera.updateProjectionMatrix();
    runtime.camera.lookAt(runtime.target);
  }, []);

  const loadScene = useCallback(async (manifestUrl: string) => {
    loadRequestRef.current?.abort();
    const controller = new AbortController();
    loadRequestRef.current = controller;
    setStatus("Reading scene manifest");
    setLoadProgress(8);
    const manifestResponse = await fetch(manifestUrl, { signal: controller.signal });
    if (!manifestResponse.ok) throw new Error(`Manifest returned ${manifestResponse.status}`);
    const nextManifest = validateManifest(await manifestResponse.json());
    setActiveManifestUrl(manifestUrl);
    setManifest(nextManifest);
    setStatus("Streaming packed splats");
    setLoadProgress(18);
    const binaryResponse = await fetch(resolveSceneUrl(manifestUrl, nextManifest.binary_url), {
      signal: controller.signal,
    });
    if (!binaryResponse.ok) throw new Error(`Scene returned ${binaryResponse.status}`);
    const buffer = await binaryResponse.arrayBuffer();
    const decoded = decodeDgsi(buffer, nextManifest);
    const { count, positions, colors, scales, semantics, phases, changes, opacities } = decoded;
    setSemanticCounts(decoded.semanticCounts);
    setChangedCount(decoded.changedCount);
    setUncertainCount(decoded.uncertainCount);
    setMeanChange(decoded.meanChange);
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute("aSemantic", new THREE.BufferAttribute(semantics, 1));
    geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute("aChange", new THREE.BufferAttribute(changes, 1));
    geometry.setAttribute("aOpacity", new THREE.BufferAttribute(opacities, 1));
    geometry.setDrawRange(0, Math.floor(count * 0.18));
    runtime.points.geometry = geometry;
    runtime.geometry = geometry;
    runtime.pointCount = count;
    runtime.positions = positions;
    runtime.semantic = semantics;
    const center = new THREE.Vector3(
      (nextManifest.bounds.min[0] + nextManifest.bounds.max[0]) / 2,
      (nextManifest.bounds.min[1] + nextManifest.bounds.max[1]) / 2,
      (nextManifest.bounds.min[2] + nextManifest.bounds.max[2]) / 2,
    );
    runtime.target.copy(center);
    runtime.cameraPathFrames = nextManifest.camera_path;
    runtime.boundsMin.copy(vector(nextManifest.spatial.navigable_bounds.min));
    runtime.boundsMax.copy(vector(nextManifest.spatial.navigable_bounds.max));
    runtime.entryPosition.copy(vector(nextManifest.spatial.entry_pose.position));
    runtime.entryTarget.copy(vector(nextManifest.spatial.entry_pose.target));
    const diagonal = vector(nextManifest.bounds.max).distanceTo(vector(nextManifest.bounds.min));
    runtime.distance = THREE.MathUtils.clamp(diagonal * 0.62, 4.8, 15);
    if (runtime.navigation === "walk") {
      runtime.walkPosition.copy(runtime.entryPosition);
      const angles = directionAngles(runtime.entryPosition, runtime.entryTarget);
      runtime.yaw = angles.yaw;
      runtime.pitch = angles.pitch;
      updateWalkCamera(runtime);
    } else {
      updateOrbitCamera(runtime);
    }
    const stages = nextManifest.progressive_chunks;
    for (const [index, stage] of stages.entries()) {
      window.setTimeout(() => {
        const current = runtimeRef.current;
        if (!current || current.geometry !== geometry) return;
        geometry.setDrawRange(0, Math.floor(count * stage * qualityRef.current / 100));
        setLoadProgress(25 + Math.round(stage * 75));
        if (index === stages.length - 1) {
          setStatus("Scene ready");
          setNotice(
            nextManifest.quality.warnings[0] ??
              `${nextManifest.quality.reconstruction_mode.replace("-", " ")} · deterministic package`,
          );
        }
      }, index * 260);
    }
  }, [updateOrbitCamera, updateWalkCamera]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#050807");
    scene.fog = new THREE.FogExp2("#050807", 0.075);
    const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.xr.enabled = true;
    mount.appendChild(renderer.domElement);
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexColors: true,
      uniforms: {
        uTimeline: { value: 0.42 },
        uPointScale: { value: 82 },
        uSelected: { value: -1 },
        uHeatmap: { value: 0 },
        uExposure: { value: 1.05 },
        uVisibility: { value: new THREE.Vector4(1, 1, 1, 1) },
        uVisible4: { value: 1 },
      },
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    const runtime: Runtime = {
      renderer, scene, camera, material, points, geometry, pointCount: 0,
      semantic: new Float32Array(), positions: new Float32Array(),
      target: new THREE.Vector3(0, 0, -1.2), yaw: 0.2, pitch: 0.18, distance: 5.5,
      dragging: false, dragMoved: false, lastPointer: { x: 0, y: 0 },
      cameraPathEnabled: false, cameraPathFrames: [], navigation: "orbit",
      walkPosition: new THREE.Vector3(0, 0, 2.5),
      entryPosition: new THREE.Vector3(0, 0, 2.5),
      entryTarget: new THREE.Vector3(0, 0, 0),
      boundsMin: new THREE.Vector3(-6, -1.4, -6),
      boundsMax: new THREE.Vector3(6, 3, 6),
      keys: new Set<string>(), timeline: 0.42, lastFrameTime: performance.now(),
    };
    runtimeRef.current = runtime;
    updateOrbitCamera(runtime);
    const resize = () => {
      const rect = mount.getBoundingClientRect();
      camera.aspect = rect.width / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    const moveKeys = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "ShiftLeft", "ShiftRight",
    ]);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!moveKeys.has(event.code)) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
      runtime.keys.add(event.code);
      if (runtime.navigation === "walk") {
        event.preventDefault();
        if (!event.repeat) {
          const forward = new THREE.Vector3(Math.sin(runtime.yaw), 0, -Math.cos(runtime.yaw));
          const right = new THREE.Vector3(Math.cos(runtime.yaw), 0, Math.sin(runtime.yaw));
          const step = new THREE.Vector3();
          if (event.code === "KeyW" || event.code === "ArrowUp") step.add(forward);
          if (event.code === "KeyS" || event.code === "ArrowDown") step.sub(forward);
          if (event.code === "KeyD" || event.code === "ArrowRight") step.add(right);
          if (event.code === "KeyA" || event.code === "ArrowLeft") step.sub(right);
          if (event.code === "KeyE") step.y += 1;
          if (event.code === "KeyQ") step.y -= 1;
          if (step.lengthSq()) {
            runtime.walkPosition.add(step.normalize().multiplyScalar(0.09));
            updateWalkCamera(runtime);
          }
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => runtime.keys.delete(event.code);
    const onBlur = () => runtime.keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    let frames = 0;
    let fpsStart = performance.now();
    renderer.setAnimationLoop((now) => {
      const delta = Math.min(0.05, Math.max(0, (now - runtime.lastFrameTime) / 1000));
      runtime.lastFrameTime = now;
      if (runtime.cameraPathEnabled) {
        applyCameraPath(runtime);
      } else if (runtime.navigation === "walk") {
        const forward = new THREE.Vector3(Math.sin(runtime.yaw), 0, -Math.cos(runtime.yaw));
        const right = new THREE.Vector3(Math.cos(runtime.yaw), 0, Math.sin(runtime.yaw));
        const motion = new THREE.Vector3();
        if (runtime.keys.has("KeyW") || runtime.keys.has("ArrowUp")) motion.add(forward);
        if (runtime.keys.has("KeyS") || runtime.keys.has("ArrowDown")) motion.sub(forward);
        if (runtime.keys.has("KeyD") || runtime.keys.has("ArrowRight")) motion.add(right);
        if (runtime.keys.has("KeyA") || runtime.keys.has("ArrowLeft")) motion.sub(right);
        if (runtime.keys.has("KeyE")) motion.y += 1;
        if (runtime.keys.has("KeyQ")) motion.y -= 1;
        if (motion.lengthSq()) {
          const boosted = runtime.keys.has("ShiftLeft") || runtime.keys.has("ShiftRight");
          runtime.walkPosition.add(motion.normalize().multiplyScalar(delta * (boosted ? 3.4 : 1.55)));
          updateWalkCamera(runtime);
        }
      }
      renderer.render(scene, camera);
      frames += 1;
      if (now - fpsStart > 700) {
        setFps(Math.round((frames * 1000) / (now - fpsStart)));
        frames = 0;
        fpsStart = now;
      }
    });
    loadScene(DEFAULT_MANIFEST).catch((error: Error) => {
      if (error.name === "AbortError") return;
      setStatus("Scene unavailable");
      setNotice(error.message);
    });
    return () => {
      loadRequestRef.current?.abort();
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      renderer.setAnimationLoop(null);
      scene.remove(points);
      runtime.geometry.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      material.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
      runtimeRef.current = null;
    };
  }, [applyCameraPath, loadScene, updateOrbitCamera, updateWalkCamera]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.material.uniforms.uSelected.value = selected ?? -1;
  }, [selected]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.material.uniforms.uHeatmap.value = heatmap ? 1 : 0;
  }, [heatmap]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.material.uniforms.uExposure.value = exposure / 100;
  }, [exposure]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.cameraPathEnabled = cameraPath;
  }, [cameraPath]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.navigation = navigation;
    runtime.keys.clear();
    if (navigation === "walk") {
      runtime.cameraPathEnabled = false;
      runtime.walkPosition.copy(runtime.entryPosition);
      const angles = directionAngles(runtime.entryPosition, runtime.entryTarget);
      runtime.yaw = angles.yaw;
      runtime.pitch = angles.pitch;
      updateWalkCamera(runtime);
    } else {
      runtime.camera.fov = 52;
      runtime.camera.updateProjectionMatrix();
      const center = runtime.boundsMin.clone().add(runtime.boundsMax).multiplyScalar(0.5);
      runtime.target.copy(center);
      runtime.yaw = 0.2;
      runtime.pitch = 0.18;
      updateOrbitCamera(runtime);
    }
  }, [navigation, updateOrbitCamera, updateWalkCamera]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.material.uniforms.uVisibility.value.set(
      visible[0] ? 1 : 0, visible[1] ? 1 : 0, visible[2] ? 1 : 0, visible[3] ? 1 : 0,
    );
    runtime.material.uniforms.uVisible4.value = visible[4] ? 1 : 0;
  }, [visible]);

  useEffect(() => {
    qualityRef.current = quality;
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.pointCount) return;
    runtime.geometry.setDrawRange(0, Math.floor(runtime.pointCount * quality / 100));
    runtime.material.uniforms.uPointScale.value = 65 + quality * 0.22;
  }, [quality]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.material.uniforms.uTimeline.value = timeline / 100;
    runtime.timeline = timeline / 100;
  }, [timeline]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTimeline((value) => (value + 0.3) % 100), 60);
    return () => window.clearInterval(timer);
  }, [playing]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.dragging = true;
    runtime.dragMoved = false;
    runtime.lastPointer = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime?.dragging) return;
    const dx = event.clientX - runtime.lastPointer.x;
    const dy = event.clientY - runtime.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) runtime.dragMoved = true;
    runtime.lastPointer = { x: event.clientX, y: event.clientY };
    runtime.yaw -= dx * 0.006;
    runtime.pitch += (runtime.navigation === "walk" ? -1 : 1) * dy * 0.005;
    if (runtime.navigation === "walk") updateWalkCamera(runtime);
    else updateOrbitCamera(runtime);
  };

  const pickPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    const mount = mountRef.current;
    if (!runtime || !mount || runtime.dragging) return;
    const rect = mount.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.08;
    raycaster.setFromCamera(pointer, runtime.camera);
    const hit = raycaster.intersectObject(runtime.points)[0];
    if (hit?.index === undefined) return;
    const point = new THREE.Vector3(
      runtime.positions[hit.index * 3],
      runtime.positions[hit.index * 3 + 1],
      runtime.positions[hit.index * 3 + 2],
    );
    if (measureMode) {
      setMeasurePoints((points) => [...points.slice(-1), point]);
      setNotice("Measurement anchor placed");
    } else {
      const semanticId = Math.round(runtime.semantic[hit.index]);
      setSelected(semanticId);
      setNotice(`${manifest?.semantics[semanticId]?.name ?? "Object"} selected · splat ${hit.index.toLocaleString()}`);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const moved = runtime.dragMoved;
    runtime.dragging = false;
    if (!moved) pickPoint(event);
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (runtime.navigation === "walk") {
      const forward = new THREE.Vector3(Math.sin(runtime.yaw), 0, -Math.cos(runtime.yaw));
      runtime.walkPosition.addScaledVector(forward, -event.deltaY * 0.002);
      updateWalkCamera(runtime);
    } else {
      runtime.distance += event.deltaY * 0.004;
      updateOrbitCamera(runtime);
    }
  };

  const ingestSelection = async (files: File[]) => {
    if (!files.length) return;
    const imageCount = files.filter((file) => file.type.startsWith("image/")).length;
    const videoCount = files.filter((file) => file.type.startsWith("video/")).length;
    setIngesting(true);
    setStatus("Building unified space");
    setNotice(
      `Uploading ${imageCount} image${imageCount === 1 ? "" : "s"} + ${videoCount} video${videoCount === 1 ? "" : "s"} · every source contributes frames`,
    );
    try {
      const body = new FormData();
      files.forEach((file) => body.append("files", file));
      const response = await fetch(`${API_BASE}/api/ingest`, { method: "POST", body });
      if (!response.ok) {
        const detail = (await response.json()) as { detail?: string };
        throw new Error(detail.detail ?? `Ingestion returned ${response.status}`);
      }
      const result = (await response.json()) as {
        scene_url: string;
        quality: SceneManifest["quality"];
        source: SceneManifest["source"];
        spatial: SceneManifest["spatial"];
      };
      await loadScene(result.scene_url);
      setNotice(
        result.quality.warnings[0] ??
          `${result.source.frame_count} frames unified into a ${result.spatial.layout.replaceAll("-", " ")}`,
      );
    } catch (error) {
      setStatus("Capture could not be opened");
      setNotice(error instanceof Error ? error.message : "Could not ingest this capture.");
    } finally {
      setIngesting(false);
    }
  };

  const ingestFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    await ingestSelection(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onDrop = async (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropActive(false);
    await ingestSelection(Array.from(event.dataTransfer.files));
  };

  const enterXr = async () => {
    type XRSystemLike = {
      isSessionSupported(mode: string): Promise<boolean>;
      requestSession(mode: string, options?: object): Promise<unknown>;
    };
    const xr = (navigator as Navigator & { xr?: XRSystemLike }).xr;
    const renderer = runtimeRef.current?.renderer;
    if (!xr || !renderer) {
      setXrLabel("XR not available here");
      setNotice("WebXR requires a supported headset, browser, and secure context.");
      return;
    }
    try {
      const supported = await xr.isSessionSupported("immersive-vr");
      if (!supported) {
        setXrLabel("Headset not detected");
        setNotice("This browser is WebXR-aware, but no immersive VR session is currently available.");
        return;
      }
      const session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
      await renderer.xr.setSession(session as never);
      setXrLabel("Spatial view active");
    } catch {
      setXrLabel("XR session cancelled");
      setNotice("The spatial session was not started; the desktop scene remains available.");
    }
  };

  const distance = measurePoints.length === 2 ? measurePoints[0].distanceTo(measurePoints[1]) : null;
  const semantics = manifest?.semantics ?? [
    { id: 0, name: "Structure", color: "#8ea0ad" },
    { id: 1, name: "Glazing", color: "#65d6ff" },
    { id: 2, name: "People", color: "#ffb547" },
    { id: 3, name: "Vegetation", color: "#67e8a3" },
    { id: 4, name: "Installed work", color: "#b58cff" },
  ];
  const totalPoints = manifest?.point_count ?? 0;
  const visiblePoints = semanticCounts.reduce(
    (total, count, index) => total + (visible[index] ? count : 0),
    0,
  );
  const visibleBudgetPoints = Math.floor(visiblePoints * quality / 100);
  const envelopeDiagonal = manifest
    ? Math.hypot(
        manifest.bounds.max[0] - manifest.bounds.min[0],
        manifest.bounds.max[1] - manifest.bounds.min[1],
        manifest.bounds.max[2] - manifest.bounds.min[2],
      )
    : 0;
  const sceneUnits = manifest?.coordinate_system?.metric_scale_known ? "m" : "su";
  const durationSeconds = manifest?.timeline.duration_seconds ?? 12;

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><b>DGSI</b><small>SCENE INTELLIGENCE</small></div>
        </div>
        <div className="scene-identity">
          <span className="status-dot" />
          <div>
            <strong>{manifest?.title ?? "Construction Atrium · Phase 02"}</strong>
            <small>
              {manifest
                ? `${manifest.source.image_count} images + ${manifest.source.video_count} videos · ${manifest.source.frame_count} extracted frames`
                : "Bundled spatial record"}
            </small>
          </div>
        </div>
        <div className="top-actions">
          <span className="pipeline-pill"><i /> LOCAL · DETERMINISTIC</span>
          <button className="button secondary" onClick={() => fileRef.current?.click()} disabled={ingesting}>
            {ingesting ? "Building space…" : "Import images + videos"}
          </button>
          <input ref={fileRef} className="visually-hidden" type="file" multiple accept="image/*,video/*" onChange={ingestFiles} />
          <button className="button primary" onClick={enterXr}>{xrLabel}<span>↗</span></button>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-panel panel">
          <section>
            <div className="section-heading"><span>SEMANTIC LAYERS</span><button aria-label="Layer options">•••</button></div>
            <div className="semantic-list">
              {semantics.map((item, index) => (
                <div key={item.id} className={`semantic-row ${selected === item.id ? "selected" : ""}`}>
                  <button
                    className="semantic-select"
                    onClick={() => setSelected(selected === item.id ? null : item.id)}
                    aria-pressed={selected === item.id}
                  >
                    <span className="semantic-swatch" style={{ "--swatch": item.color } as React.CSSProperties} />
                    <span>
                      <b>{item.name}</b>
                      <small>
                        {totalPoints ? Math.round((semanticCounts[index] ?? 0) / totalPoints * 100) : 0}% of scene
                      </small>
                    </span>
                  </button>
                  <input
                    type="checkbox"
                    checked={visible[index]}
                    aria-label={`Toggle ${item.name}`}
                    onChange={() => setVisible((state) => state.map((value, i) => i === index ? !value : value))}
                  />
                </div>
              ))}
            </div>
          </section>
          <section className="inspector-card">
            <div className="eyebrow">SELECTION</div>
            <div className="selection-visual"><span /><i /><i /><i /></div>
            <div className="selection-title">
              <span><b>{selected === null ? "Whole scene" : semantics[selected]?.name}</b><small>{selected === null ? "Scene envelope" : `Semantic class 0${selected + 1}`}</small></span>
              <span className="confidence">{selected === null ? "100" : "94"}%</span>
            </div>
            <dl>
              <div><dt>Visible splats</dt><dd>{formatPoints(visibleBudgetPoints)}</dd></div>
              <div><dt>Envelope diagonal</dt><dd>{envelopeDiagonal.toFixed(2)} {sceneUnits}</dd></div>
              <div><dt>Mean change score</dt><dd className="accent">{Math.round(meanChange * 100)}%</dd></div>
            </dl>
            {selected !== null && (
              <button
                className="remove-selection"
                onClick={() => {
                  setVisible((state) => state.map((value, index) => index === selected ? false : value));
                  setNotice(`${semantics[selected]?.name ?? "Selection"} hidden non-destructively`);
                }}
              >
                Hide selected class
              </button>
            )}
          </section>
          <div className="left-footer">
            <span>
              {manifest
                ? `${manifest.source.file_count} FILES · ${manifest.spatial.layout.replaceAll("-", " ")}`
                : "SCENE PROVENANCE"}
            </span>
            <a href={activeManifestUrl} target="_blank" rel="noreferrer">View manifest ↗</a>
          </div>
        </aside>

        <section
          className={`viewport ${dropActive ? "drop-active" : ""} ${navigation === "walk" ? "walk-mode" : ""}`}
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
          onDrop={onDrop}
        >
          <div ref={mountRef} className="canvas-mount" />
          <div className="viewport-vignette" />
          <div className="viewport-top">
            <div className="view-chip"><span className="pulse" /> {navigation === "walk" ? "EXPLORE SPACE" : "ORBIT INSPECTION"}</div>
            <div className="view-chip subtle">
              {fps} FPS <i /> {formatPoints(visibleBudgetPoints)} SPLATS <i /> {manifest?.spatial.layout.replaceAll("-", " ") ?? "loading"}
            </div>
          </div>
          {dropActive && (
            <div className="drop-overlay">
              <strong>Drop every capture here</strong>
              <span>Images and multiple videos will be sampled, checked, and unified into one navigable space.</span>
            </div>
          )}
          {loadProgress < 100 && (
            <div className="loading-card">
              <span>{status}</span><strong>{loadProgress}%</strong>
              <div><i style={{ width: `${loadProgress}%` }} /></div>
            </div>
          )}
          {distance !== null && (
            <div className="measure-tag"><span>ANCHOR DISTANCE</span><b>{distance.toFixed(2)} {sceneUnits}</b></div>
          )}
          <div className="viewport-tools">
            <button className={measureMode ? "active" : ""} onClick={(event) => { event.stopPropagation(); setMeasureMode(!measureMode); setMeasurePoints([]); }} title="Measure">⌁</button>
            <button
              className={navigation === "walk" ? "active" : ""}
              aria-pressed={navigation === "walk"}
              onClick={(event) => {
                event.stopPropagation();
                setCameraPath(false);
                const next = navigation === "walk" ? "orbit" : "walk";
                setNavigation(next);
                setNotice(
                  next === "walk"
                    ? "Walk mode · WASD or arrows move · Q/E change height · Shift boosts"
                    : "Orbit mode · Drag to rotate · Scroll to dolly · Drop captures to rebuild",
                );
              }}
              title="Walk through space"
            >
              ⌖
            </button>
            <button
              className={cameraPath ? "active" : ""}
              onClick={(event) => {
                event.stopPropagation();
                setNavigation("orbit");
                setCameraPath(!cameraPath);
              }}
              title="Camera path"
            >
              ◉
            </button>
            <button onClick={(event) => {
              event.stopPropagation();
              const runtime = runtimeRef.current;
              if (!runtime) return;
              if (runtime.navigation === "walk") {
                runtime.walkPosition.copy(runtime.entryPosition);
                const angles = directionAngles(runtime.entryPosition, runtime.entryTarget);
                runtime.yaw = angles.yaw;
                runtime.pitch = angles.pitch;
                updateWalkCamera(runtime);
              } else {
                runtime.yaw = .2;
                runtime.pitch = .18;
                runtime.distance = 5.5;
                updateOrbitCamera(runtime);
              }
            }} title="Reset view">↺</button>
          </div>
          {navigation === "walk" && (
            <div className="navigation-hud" role="status">
              <b>W A S D</b><span>move</span><b>Q / E</b><span>height</span><b>SHIFT</b><span>boost</span>
              <span ref={cameraReadoutRef} className="camera-readout">X 0.00 · Y 0.00 · Z 0.00 su</span>
            </div>
          )}
          <div className="orientation-gizmo" aria-hidden="true"><span className="axis y">Y</span><span className="axis x">X</span><span className="axis z">Z</span><i /></div>
          <div className="viewport-note">{notice}</div>
        </section>

        <aside className="right-panel panel">
          <section className="change-header">
            <div><span className="eyebrow">CHANGE INTELLIGENCE</span><h2>Compare dates</h2></div>
            <button className={`toggle ${heatmap ? "on" : ""}`} onClick={() => setHeatmap(!heatmap)} aria-label="Toggle change heatmap"><i /></button>
          </section>
          <div className="date-compare">
            <div><span>A</span><p><b>Baseline</b><small>Capture start</small></p></div>
            <i>→</i>
            <div><span className="b">B</span><p><b>Current</b><small>{manifest?.timeline.comparison_label ?? "Capture end"}</small></p></div>
          </div>
          <div className="change-summary">
            <div><span className="metric-icon">↗</span><p><small>CHANGED SPLATS</small><b>{formatPoints(changedCount)}</b></p><em>{totalPoints ? Math.round(changedCount / totalPoints * 100) : 0}%</em></div>
            <div><span className="metric-icon cool">≈</span><p><small>MEAN SCORE</small><b>{Math.round(meanChange * 100)}%</b></p><em className="neutral">Temporal proxy</em></div>
            <div><span className="metric-icon muted">?</span><p><small>LOW CONFIDENCE</small><b>{formatPoints(uncertainCount)}</b></p><em className="neutral">Review</em></div>
          </div>
          <section className="control-group">
            <div className="control-label"><span>Rendering budget</span><output>{quality}%</output></div>
            <input aria-label="Rendering budget" type="range" min="20" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
            <div className="range-caption"><span>Compressed</span><span>Full fidelity</span></div>
          </section>
          <section className="control-group">
            <div className="control-label"><span>Relighting exposure</span><output>{(exposure / 100).toFixed(2)}×</output></div>
            <input aria-label="Relighting exposure" type="range" min="55" max="155" value={exposure} onChange={(event) => setExposure(Number(event.target.value))} />
            <div className="light-presets"><button onClick={() => setExposure(70)}>DUSK</button><button className="active" onClick={() => setExposure(105)}>SURVEY</button><button onClick={() => setExposure(140)}>HIGH KEY</button></div>
          </section>
          <section className="quality-card">
            <div><span>CAPTURE QUALITY</span><b>{Math.round((manifest?.quality.median_relatedness ?? .94) * 100)}<small>/100</small></b></div>
            <div className="quality-bar"><i /></div>
            <p>{manifest?.quality.reconstruction_mode.replace("-", " ") ?? "surrogate reconstruction"} · {manifest?.quality.warnings.length ?? 0} warning(s)</p>
          </section>
          <div className="right-footer">
            <button className={heatmap ? "active" : ""} onClick={() => setHeatmap(!heatmap)}><span>◐</span> Change map</button>
            <button className={cameraPath ? "active" : ""} onClick={() => {
              setNavigation("orbit");
              setCameraPath(!cameraPath);
            }}><span>⌁</span> Camera path</button>
          </div>
        </aside>
      </section>

      <footer className="timeline">
        <button className="play-button" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause timeline" : "Play timeline"}>{playing ? "Ⅱ" : "▶"}</button>
        <div className="timecode">
          <b>00:{String(Math.round(timeline / 100 * durationSeconds)).padStart(2, "0")}.0</b>
          <span>/ 00:{String(Math.round(durationSeconds)).padStart(2, "0")}.0</span>
        </div>
        <div className="timeline-track">
          <div className="timeline-labels"><span>WEEK 12 · BASELINE</span><span>WEEK 18 · CURRENT</span></div>
          <input aria-label="Scene timeline" type="range" min="0" max="100" step=".1" value={timeline} onChange={(event) => { setTimeline(Number(event.target.value)); setPlaying(false); }} />
          <div className="events"><i style={{ left: "27%" }} /><i style={{ left: "61%" }} /><i style={{ left: "82%" }} /></div>
        </div>
        <div className="timeline-mode"><span>4D MOTION</span><button className={`toggle small ${playing ? "on" : ""}`} onClick={() => setPlaying(!playing)}><i /></button></div>
      </footer>
    </main>
  );
}
