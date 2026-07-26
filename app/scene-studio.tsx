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
import {
  completionDisclosure,
  GENERATION_STEPS,
  nextPortalPhase,
  PortalPhase,
  renderedCaptureEvidence,
  roomAfterPortalAction,
  RoomProvenance,
  roomProvenanceLabel,
  videoSampleFractions,
} from "./procedural-world";

type Theme = "dark" | "light";
type ViewMode = "explore" | "source" | "coverage" | "inspect";
type Navigation = "look" | "walk";
type SceneClass = "panorama-context" | "completed-context" | "preview-proxy" | "imported-gaussian";
type SceneOrigin = "eso" | "completed" | "generated" | "spz";
type ExampleId = "eso" | "layered" | "kitchen" | "procedural" | "custom";

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
  proceduralWorld: THREE.Group;
  proceduralTextures: THREE.Texture[];
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
  portalNear: boolean;
};

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const DEFAULT_MANIFEST = `${PUBLIC_BASE_PATH}/room-demo/manifest.json`;
const CONTEXT_4K_URL = `${PUBLIC_BASE_PATH}/captures/eso-guesthouse/context-webgl.jpg`;
const CONTEXT_8K_URL = `${PUBLIC_BASE_PATH}/captures/eso-guesthouse/context-8k.jpg`;
const COMPLETION_API = process.env.NEXT_PUBLIC_WORLD_COMPLETION_API_URL ?? "";
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

function loadImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The source image could not be decoded"));
    image.src = url;
  });
}

async function bitmapSignature(bitmap: ImageBitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas evidence analysis is unavailable");
  context.drawImage(bitmap, 0, 0, 16, 16);
  const pixels = context.getImageData(0, 0, 16, 16).data;
  const luminance = Array.from({ length: 256 }, (_, index) => {
    const offset = index * 4;
    return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
  });
  const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  return luminance.map((value) => value >= mean ? "1" : "0").join("");
}

async function bitmapPreviewUrl(bitmap: ImageBitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas texture generation is unavailable");
  drawCover(context, bitmap, bitmap.width, bitmap.height, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Layer texture generation failed")), "image/jpeg", 0.9),
  );
  return URL.createObjectURL(blob);
}

async function framesFromMedia(file: File) {
  if (file.type.startsWith("image/")) return [await createImageBitmap(file)];
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error(`${file.name} could not be decoded`));
    });
    const duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : 1;
    const sampleFractions = videoSampleFractions(duration);
    const frames: ImageBitmap[] = [];
    for (const fraction of sampleFractions) {
      const target = Math.min(Math.max(0, duration * fraction), Math.max(0, duration - 0.04));
      if (Math.abs(video.currentTime - target) > 0.01) {
        video.currentTime = target;
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 1200);
          video.addEventListener("seeked", () => {
            window.clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, video.videoWidth);
      canvas.height = Math.max(1, video.videoHeight);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas completion is unavailable");
      context.drawImage(video, 0, 0);
      frames.push(await createImageBitmap(canvas));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const sourceX = (sourceWidth - cropWidth) / 2;
  const sourceY = (sourceHeight - cropHeight) / 2;
  context.drawImage(image, sourceX, sourceY, cropWidth, cropHeight, x, y, width, height);
}

async function completedPanoramaFromMedia(files: File[]) {
  const supported = files
    .filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"))
    .slice(0, 8);
  if (!supported.length) throw new Error("Choose at least one image or video");
  const framesByAsset = await Promise.all(supported.map(framesFromMedia));
  const frames: ImageBitmap[] = [];
  for (let sample = 0; frames.length < 8; sample += 1) {
    let added = false;
    for (const assetFrames of framesByAsset) {
      if (assetFrames[sample] && frames.length < 8) {
        frames.push(assetFrames[sample]);
        added = true;
      }
    }
    if (!added) break;
  }
  const unusedFrames = framesByAsset.flat().filter((frame) => !frames.includes(frame));
  unusedFrames.forEach((frame) => frame.close());
  try {
    const signatures = await Promise.all(frames.map(bitmapSignature));
    const frameUrls = await Promise.all(frames.map(bitmapPreviewUrl));
    const canvas = document.createElement("canvas");
    canvas.width = 4096;
    canvas.height = 2048;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas completion is unavailable");
    const first = frames[0];
    context.filter = "saturate(0.86) brightness(0.82)";
    drawCover(context, first, first.width, first.height, -120, -120, canvas.width + 240, canvas.height + 240);
    context.filter = "none";
    const bandTop = 380;
    const bandHeight = 1288;
    const segmentWidth = canvas.width / frames.length;
    frames.forEach((frame, index) => {
      drawCover(
        context,
        frame,
        frame.width,
        frame.height,
        index * segmentWidth,
        bandTop,
        segmentWidth + 2,
        bandHeight,
      );
    });
    const topFade = context.createLinearGradient(0, 0, 0, bandTop + 220);
    topFade.addColorStop(0, "rgba(25,22,20,.48)");
    topFade.addColorStop(1, "rgba(25,22,20,0)");
    context.fillStyle = topFade;
    context.fillRect(0, 0, canvas.width, bandTop + 220);
    const floorFade = context.createLinearGradient(0, bandTop + bandHeight - 180, 0, canvas.height);
    floorFade.addColorStop(0, "rgba(20,18,16,0)");
    floorFade.addColorStop(1, "rgba(20,18,16,.46)");
    context.fillStyle = floorFade;
    context.fillRect(0, bandTop + bandHeight - 180, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Context completion failed")), "image/jpeg", 0.9),
    );
    return {
      panoramaUrl: URL.createObjectURL(blob),
      frameUrls,
      signatures,
      renderedCaptures: frames.length,
      videoFrameCount: supported.some((file) => file.type.startsWith("video/"))
        ? framesByAsset
          .filter((_, index) => supported[index].type.startsWith("video/"))
          .reduce((sum, items) => sum + items.filter((item) => frames.includes(item)).length, 0)
        : 0,
    };
  } finally {
    frames.forEach((frame) => frame.close());
  }
}

async function continuationFromPanorama() {
  const canvas = document.createElement("canvas");
  canvas.width = 4096;
  canvas.height = 2048;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas completion is unavailable");
  const ceiling = context.createLinearGradient(0, 0, 0, 680);
  ceiling.addColorStop(0, "#bdb6aa");
  ceiling.addColorStop(1, "#766f65");
  context.fillStyle = ceiling;
  context.fillRect(0, 0, canvas.width, 680);
  context.fillStyle = "#625d55";
  context.fillRect(0, 680, canvas.width, 760);
  const floor = context.createLinearGradient(0, 1420, 0, canvas.height);
  floor.addColorStop(0, "#4b443c");
  floor.addColorStop(1, "#171614");
  context.fillStyle = floor;
  context.fillRect(0, 1420, canvas.width, canvas.height - 1420);
  const alcoves = [220, 1040, 1860, 2680, 3500];
  alcoves.forEach((x, index) => {
    const opening = context.createLinearGradient(x, 0, x + 360, 0);
    opening.addColorStop(0, "#393631");
    opening.addColorStop(0.5, index === 2 ? "#121211" : "#25231f");
    opening.addColorStop(1, "#393631");
    context.fillStyle = opening;
    context.fillRect(x, 720, 360, 720);
    context.strokeStyle = "#958b7d";
    context.lineWidth = 14;
    context.strokeRect(x - 7, 713, 374, 734);
    context.strokeStyle = "rgba(216,204,184,.24)";
    context.lineWidth = 3;
    context.strokeRect(x + 34, 760, 292, 630);
  });
  context.fillStyle = "#777066";
  context.fillRect(0, 1370, canvas.width, 70);
  context.strokeStyle = "rgba(235,224,204,.18)";
  context.lineWidth = 3;
  for (let x = 0; x < canvas.width; x += 210) {
    context.beginPath();
    context.moveTo(x, 690);
    context.lineTo(x, 1370);
    context.stroke();
  }
  context.fillStyle = "rgba(255,235,190,.72)";
  for (const x of [520, 1420, 2676, 3576]) {
    context.beginPath();
    context.ellipse(x, 310, 44, 18, 0, 0, Math.PI * 2);
    context.fill();
  }
  context.strokeStyle = "rgba(202,188,164,.22)";
  context.lineWidth = 3;
  for (let y = 1510; y < canvas.height; y += 92) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }
  context.strokeStyle = "rgba(202,188,164,.15)";
  for (let x = -400; x < canvas.width + 400; x += 320) {
    context.beginPath();
    context.moveTo(x, canvas.height);
    context.lineTo(2048 + (x - 2048) * 0.22, 1438);
    context.stroke();
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Continuation completion failed")), "image/jpeg", 0.91),
  );
  return URL.createObjectURL(blob);
}

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
  const stageRef = useRef<HTMLElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const doorwayTriggerRef = useRef<HTMLButtonElement>(null);
  const portalDialogRef = useRef<HTMLElement>(null);
  const portalPrimaryRef = useRef<HTMLButtonElement>(null);
  const portalReturnFocusRef = useRef<HTMLElement | null>(null);
  const localUrlsRef = useRef<Set<string>>(new Set());
  const roomUrlsRef = useRef<{ observed: string; continuation: string | null }>({
    observed: CONTEXT_8K_URL,
    continuation: null,
  });
  const roomLayerUrlsRef = useRef<{ observed: string[]; continuation: string[] }>({
    observed: [],
    continuation: [],
  });
  const observedRoomRef = useRef<{
    title: string;
    origin: "eso" | "completed";
    sceneClass: "panorama-context" | "completed-context";
    coverage: number;
    summary: string;
  }>({
    title: "ESO Guesthouse · Vitacura",
    origin: "eso",
    sceneClass: "panorama-context",
    coverage: 100,
    summary: "12 observed directions",
  });
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
  const [portalPhase, setPortalPhase] = useState<PortalPhase>("idle");
  const [portalGateOpen, setPortalGateOpen] = useState(false);
  const [generationStep, setGenerationStep] = useState(0);
  const [activeRoom, setActiveRoom] = useState<1 | 2>(1);
  const [observedPercent, setObservedPercent] = useState(100);
  const [roomOneObservedPercent, setRoomOneObservedPercent] = useState(100);
  const [providerUsed, setProviderUsed] = useState(false);
  const [captureSummary, setCaptureSummary] = useState("12 observed directions");
  const [roomRecords, setRoomRecords] = useState<{
    room1: RoomProvenance;
    room2: RoomProvenance | null;
  }>({
    room1: {
      room: 1,
      sourceLabel: "ESO Guesthouse panorama",
      renderedCaptures: 12,
      uniqueCaptures: 12,
      observedPercent: 100,
      registration: "registered-panorama",
      completion: "none",
    },
    room2: null,
  });
  const activeProvenance = activeRoom === 1 ? roomRecords.room1 : roomRecords.room2;

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
    if (sceneClass === "completed-context") {
      const isProcedural = activeProvenance?.completion === "procedural-local";
      const isRegisteredLayered = activeProvenance?.registration === "registered-panorama";
      return {
        label: isRegisteredLayered
          ? "Registered panorama + bounded depth cues"
          : providerUsed
          ? "Provider-completed context"
          : isProcedural
            ? "Local procedural completion"
            : "Deterministic completed context",
        detail: isRegisteredLayered
          ? "Observed 360° context · restrained non-metric architectural depth"
          : completionDisclosure(
            observedPercent,
            providerUsed,
            activeProvenance?.registration ?? "unregistered",
          ),
        tone: "completed",
      };
    }
    return {
      label: "360° photographic capture",
      detail: "Observed ESO panorama · context projection · not trained 3DGS",
      tone: "observed",
    };
  }, [activeProvenance, observedPercent, providerUsed, sceneClass]);
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
    if (!portalGateOpen) return;
    const frame = window.requestAnimationFrame(() => {
      (portalPrimaryRef.current ?? portalDialogRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [portalGateOpen, portalPhase]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const localUrls = localUrlsRef.current;

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
    const proceduralWorld = new THREE.Group();
    proceduralWorld.visible = false;
    scene.add(proceduralWorld);

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
      proceduralWorld, proceduralTextures: [],
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
      portalNear: false,
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
          const atThreshold =
            runtime.sceneClass !== "imported-gaussian" &&
            runtime.walkPosition.z <= runtime.safeMin.z + 0.045 &&
            Math.abs(runtime.walkPosition.x) <= 0.19;
          if (atThreshold && !runtime.portalNear) {
            runtime.portalNear = true;
            setPortalPhase((phase) => nextPortalPhase(phase, "approach"));
            portalReturnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : stageRef.current;
            setPortalGateOpen(true);
            setNotice("Unmapped threshold reached · generate the next bounded room before entering");
          } else if (!atThreshold) {
            runtime.portalNear = false;
          }
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
      localUrls.forEach((url) => URL.revokeObjectURL(url));
      localUrls.clear();
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

  const installEnvironment = async (url: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("Viewer is not ready");
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = -1;
    texture.offset.x = 1;
    texture.anisotropy = Math.min(16, runtime.renderer.capabilities.getMaxAnisotropy());
    runtime.environmentTexture?.dispose();
    runtime.environmentTexture = texture;
    runtime.environment.material.map = texture;
    runtime.environment.material.needsUpdate = true;
    runtime.environment.visible = true;
  };

  const clearProceduralWorld = (runtime: Runtime) => {
    runtime.proceduralWorld.children.forEach((child) => disposeObject(child));
    runtime.proceduralWorld.clear();
    runtime.proceduralTextures.forEach((texture) => texture.dispose());
    runtime.proceduralTextures = [];
    runtime.proceduralWorld.visible = false;
  };

  const buildProceduralRoom = async (
    frameUrls: string[],
    fallbackUrl: string,
    variant: 1 | 2,
  ) => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("Viewer is not ready");
    clearProceduralWorld(runtime);
    const textureUrls = variant === 1
      ? Array.from({ length: 2 }, (_, index) =>
        frameUrls[index % Math.max(1, frameUrls.length)] ?? fallbackUrl
      )
      : [];
    const textures = await Promise.all(textureUrls.map(async (url) => {
      const image = await loadImageElement(url);
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 640;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Layer compositing is unavailable");
      drawCover(
        context,
        image,
        image.naturalWidth,
        image.naturalHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      context.globalCompositeOperation = "destination-in";
      const horizontal = context.createLinearGradient(0, 0, canvas.width, 0);
      horizontal.addColorStop(0, "rgba(255,255,255,0)");
      horizontal.addColorStop(0.18, "rgba(255,255,255,0.82)");
      horizontal.addColorStop(0.5, "rgba(255,255,255,1)");
      horizontal.addColorStop(0.82, "rgba(255,255,255,0.82)");
      horizontal.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = horizontal;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
      vertical.addColorStop(0, "rgba(255,255,255,0)");
      vertical.addColorStop(0.2, "rgba(255,255,255,0.9)");
      vertical.addColorStop(0.78, "rgba(255,255,255,0.9)");
      vertical.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = vertical;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }));
    textures.forEach((texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(12, runtime.renderer.capabilities.getMaxAnisotropy());
    });
    runtime.proceduralTextures = textures;
    const addPost = (
      size: [number, number, number],
      position: [number, number, number],
      color: string,
      opacity: number,
    ) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...size),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      mesh.position.set(...position);
      runtime.proceduralWorld.add(mesh);
    };
    if (variant === 1) {
      // Restrained architectural depth cues create screen-space parallax without
      // floating photographic cards or implying recovered metric geometry.
      addPost([0.035, 0.82, 0.035], [-0.88, -0.24, -1.2], "#5d4939", 0.4);
      addPost([0.035, 0.78, 0.035], [0.9, -0.26, -1.28], "#5d4939", 0.38);
      addPost([1.84, 0.025, 0.025], [0, -0.64, -1.18], "#806c5b", 0.34);
    } else {
      // Room 02 is a fully procedural corridor. Geometry echoes the rendered
      // doorway frame without reusing or mirroring Room 01 photographs.
      addPost([0.045, 1.12, 0.045], [-0.43, -0.06, -1.42], "#38342f", 0.7);
      addPost([0.045, 1.12, 0.045], [0.43, -0.06, -1.42], "#38342f", 0.7);
      addPost([0.9, 0.045, 0.045], [0, 0.48, -1.42], "#38342f", 0.7);
      addPost([0.035, 0.86, 0.035], [-0.68, -0.19, -0.96], "#71685d", 0.48);
      addPost([0.035, 0.86, 0.035], [0.68, -0.19, -1.08], "#71685d", 0.48);
    }
    runtime.proceduralWorld.visible = true;
  };

  const resetWorldExpansion = (
    observedUrl: string,
    coverage = 100,
    metadata = observedRoomRef.current,
    layerUrls: string[] = [],
    provenance: RoomProvenance = {
      room: 1,
      sourceLabel: metadata.summary,
      renderedCaptures: coverage === 100 ? 12 : 0,
      uniqueCaptures: coverage === 100 ? 12 : 0,
      observedPercent: coverage,
      registration: coverage === 100 ? "registered-panorama" : "unregistered",
      completion: coverage === 100 ? "none" : "deterministic-local",
    },
  ) => {
    roomUrlsRef.current = { observed: observedUrl, continuation: null };
    roomLayerUrlsRef.current = { observed: layerUrls, continuation: [] };
    observedRoomRef.current = { ...metadata, coverage };
    setPortalPhase("idle");
    setPortalGateOpen(false);
    setGenerationStep(0);
    setActiveRoom(1);
    setObservedPercent(coverage);
    setRoomOneObservedPercent(coverage);
    setProviderUsed(false);
    setRoomRecords({ room1: provenance, room2: null });
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
    clearProceduralWorld(runtime);
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
    resetWorldExpansion(
      origin === "eso"
        ? contextUrlForRenderer(runtime.renderer)
        : environmentUrl ?? contextUrlForRenderer(runtime.renderer),
      origin === "eso" ? 100 : Math.round((checked.environment?.coverage ?? 0) * 100),
      {
        title: origin === "eso" ? "ESO Guesthouse · Vitacura" : checked.title,
        origin: origin === "eso" ? "eso" : "completed",
        sceneClass: origin === "eso" ? "panorama-context" : "completed-context",
        coverage: origin === "eso" ? 100 : Math.round((checked.environment?.coverage ?? 0) * 100),
        summary: origin === "eso"
          ? "12 observed directions"
          : `${checked.source.file_count} uploaded capture file${checked.source.file_count === 1 ? "" : "s"}`,
      },
    );
    setCaptureSummary(
      origin === "eso"
        ? "12 observed directions"
        : `${checked.source.file_count} uploaded capture file${checked.source.file_count === 1 ? "" : "s"}`,
    );
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
    clearProceduralWorld(runtime);
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
    setPortalPhase("idle");
    setPortalGateOpen(false);
    setGenerationStep(0);
    setActiveRoom(1);
    setCaptureSummary("trained Gaussian scene");
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

  const activateCompletedWorld = async (
    url: string,
    files: File[],
    usedProvider: boolean,
    capture: Awaited<ReturnType<typeof completedPanoramaFromMedia>>,
    options: {
      registered?: boolean;
      title?: string;
      example?: ExampleId;
    } = {},
  ) => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("Viewer is not ready");
    if (runtime.splat) {
      runtime.scene.remove(runtime.splat);
      runtime.splat.dispose();
      runtime.splat = null;
    }
    await installEnvironment(url);
    await buildProceduralRoom(capture.frameUrls, url, 1);
    const evidence = renderedCaptureEvidence(
      capture.signatures,
      capture.renderedCaptures,
      options.registered,
    );
    const coverage = evidence.observedPercent;
    const summary = options.registered
      ? "Registered source panorama · bounded non-metric depth cues"
      : `${evidence.unique}/${evidence.rendered} unique rendered captures` +
        `${capture.videoFrameCount ? ` · ${capture.videoFrameCount} sampled video frames` : ""} · views unregistered`;
    const provenance: RoomProvenance = {
      room: 1,
      sourceLabel: files.length === 1 ? files[0].name : `${files.length} local media assets`,
      renderedCaptures: evidence.rendered,
      uniqueCaptures: evidence.unique,
      observedPercent: coverage,
      registration: evidence.registration,
      completion: options.registered ? "none" : usedProvider ? "provider" : "deterministic-local",
    };
    runtime.sceneClass = "completed-context";
    runtime.scene.background = new THREE.Color("#171715");
    runtime.proxy.visible = false;
    runtime.safeMin.set(-0.38, -0.13, -0.48);
    runtime.safeMax.set(0.38, 0.13, 0.28);
    runtime.entryPosition.set(0, 0, 0);
    runtime.walkPosition.copy(runtime.entryPosition);
    runtime.moveSpeed = 0.36;
    runtime.canTranslate = true;
    runtime.yaw = 0;
    runtime.pitch = 0;
    runtime.desiredYaw = 0;
    runtime.desiredPitch = 0;
    runtime.camera.near = 0.02;
    runtime.camera.far = 120;
    runtime.camera.fov = 58;
    runtime.camera.updateProjectionMatrix();
    runtime.tour = "off";
    settleCamera(runtime, 0, true);
    const title = options.title ?? (files.length === 1
      ? `${files[0].name.replace(/\.[^.]+$/, "")} · Spatial preview`
      : `${files.length}-source spatial preview`);
    setTour("off");
    setManifest(null);
    setTrainedSource(null);
    setSceneClass("completed-context");
    setSceneOrigin("completed");
    setSceneTitle(title);
    setExampleId(options.example ?? "procedural");
    setContextEnabled(true);
    setMode("explore");
    setNavigation("look");
    setCanWalk(true);
    setRenderProfile("4K completed context");
    setProviderUsed(usedProvider);
    setCaptureSummary(summary);
    resetWorldExpansion(url, coverage, {
      title,
      origin: "completed",
      sceneClass: "completed-context",
      coverage,
      summary,
    }, capture.frameUrls, provenance);
    setProviderUsed(usedProvider);
    setProgress(100);
    setNotice(options.registered
      ? "Registered panorama ready · restrained architectural depth · bounded parallax"
      : completionDisclosure(coverage, usedProvider, "unregistered"));
  };

  const ingestMedia = async (
    files: File[],
    options: {
      environmentUrl?: string;
      registered?: boolean;
      title?: string;
      example?: ExampleId;
    } = {},
  ) => {
    setIngesting(true);
    setProgress(12);
    setNotice("Building a bounded spatial preview from the selected media");
    try {
      const capture = await completedPanoramaFromMedia(files);
      localUrlsRef.current.add(capture.panoramaUrl);
      capture.frameUrls.forEach((url) => localUrlsRef.current.add(url));
      let panoramaUrl = options.environmentUrl ?? capture.panoramaUrl;
      let usedProvider = false;
      if (COMPLETION_API && !options.environmentUrl) {
        try {
          const body = new FormData();
          files.forEach((file) => body.append("files", file));
          const response = await fetch(`${COMPLETION_API.replace(/\/$/, "")}/complete`, {
            method: "POST",
            body,
          });
          const result = await response.json() as { panorama_url?: string };
          if (!response.ok || !result.panorama_url) {
            throw new Error("Completion provider did not return a panorama");
          }
          panoramaUrl = result.panorama_url;
          usedProvider = true;
        } catch {
          setNotice("Provider unavailable · using deterministic on-device context fill");
        }
      }
      try {
        await activateCompletedWorld(panoramaUrl, files, usedProvider, capture, options);
      } catch (error) {
        if (!usedProvider) throw error;
        usedProvider = false;
        panoramaUrl = capture.panoramaUrl;
        await activateCompletedWorld(panoramaUrl, files, false, capture, options);
        setNotice("Provider output could not be rendered · deterministic local completion loaded");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The local spatial preview could not be built");
    } finally {
      setIngesting(false);
    }
  };

  const loadLayeredDemo = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setNotice("Opening the built-in layered capture study");
    try {
      const files = await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const response = await fetch(
            `${PUBLIC_BASE_PATH}/room-inputs/room-${String(index).padStart(2, "0")}.jpg`,
          );
          if (!response.ok) throw new Error(`Demo view ${index + 1} could not be loaded`);
          return new File(
            [await response.blob()],
            `guesthouse-view-${String(index + 1).padStart(2, "0")}.jpg`,
            { type: "image/jpeg" },
          );
        }),
      );
      const title = "Guesthouse · Layered capture study";
      await ingestMedia(files, {
        environmentUrl: contextUrlForRenderer(runtime.renderer),
        registered: true,
        title,
        example: "layered",
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The layered demo could not be loaded");
    }
  };

  const closePortalDialog = () => {
    if (portalPhase === "generating") return;
    setPortalGateOpen(false);
    if (portalPhase === "threshold") setPortalPhase("idle");
    setNotice(portalPhase === "ready"
      ? "Room 02 remains ready · continue exploring Room 01"
      : "Doorway generation cancelled · Room 01 remains active");
    window.requestAnimationFrame(() => {
      (portalReturnFocusRef.current ?? stageRef.current)?.focus();
    });
  };

  const approachDoorway = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    portalReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : doorwayTriggerRef.current;
    if (portalPhase === "ready") {
      setPortalGateOpen(true);
      setNotice("Room 02 is ready · enter when you are ready to cross");
      return;
    }
    runtime.tour = "off";
    runtime.keys.clear();
    runtime.portalNear = true;
    runtime.walkPosition.set(0, 0, runtime.safeMin.z + 0.035);
    runtime.yaw = 0;
    runtime.pitch = 0;
    runtime.desiredYaw = 0;
    runtime.desiredPitch = 0;
    settleCamera(runtime, 0, true);
    setTour("off");
    setNavigation("look");
    setPortalPhase((phase) => nextPortalPhase(phase, "approach"));
    setPortalGateOpen(true);
    setNotice("Unmapped threshold reached · generate the next bounded room before entering");
  };

  const generateBeyondDoorway = async () => {
    if (portalPhase !== "threshold") return;
    setPortalPhase((phase) => nextPortalPhase(phase, "generate"));
    setGenerationStep(0);
    try {
      for (let index = 0; index < GENERATION_STEPS.length; index += 1) {
        setGenerationStep(index);
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
      let continuationUrl = "";
      let continuationProvider = false;
      if (COMPLETION_API) {
        try {
          const response = await fetch(`${COMPLETION_API.replace(/\/$/, "")}/continue`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ panorama_url: roomUrlsRef.current.observed, doorway: "forward" }),
          });
          const result = await response.json() as { panorama_url?: string };
          if (response.ok && result.panorama_url) {
            continuationUrl = result.panorama_url;
            continuationProvider = true;
          }
        } catch {
          // The local continuation below remains available without a provider.
        }
      }
      if (!continuationUrl) {
        continuationUrl = await continuationFromPanorama();
        localUrlsRef.current.add(continuationUrl);
      }
      roomUrlsRef.current.continuation = continuationUrl;
      roomLayerUrlsRef.current.continuation = [...roomLayerUrlsRef.current.observed].reverse();
      const room2: RoomProvenance = {
        room: 2,
        sourceLabel: continuationProvider
          ? "Configured doorway-completion provider"
          : "Local procedural gallery continuation",
        renderedCaptures: 0,
        uniqueCaptures: 0,
        observedPercent: 0,
        registration: "procedural",
        completion: continuationProvider ? "provider" : "procedural-local",
      };
      setRoomRecords((records) => ({ ...records, room2 }));
      setPortalPhase((phase) => nextPortalPhase(phase, "finish"));
      setNotice(continuationProvider
        ? "Room 02 is ready · provider-completed context · bounded"
        : "Room 02 is ready · structurally distinct local procedural completion · bounded");
    } catch (error) {
      setPortalPhase("threshold");
      setNotice(error instanceof Error ? error.message : "The next room could not be generated");
    }
  };

  const enterContinuation = async () => {
    const url = roomUrlsRef.current.continuation;
    const runtime = runtimeRef.current;
    if (!runtime || portalPhase !== "ready" || !url) return;
    setIngesting(true);
    try {
      await installEnvironment(url);
      await buildProceduralRoom(roomLayerUrlsRef.current.continuation, url, 2);
      const room2 = roomRecords.room2;
      runtime.sceneClass = "completed-context";
      runtime.walkPosition.copy(runtime.entryPosition);
      runtime.yaw = Math.PI;
      runtime.pitch = 0;
      runtime.desiredYaw = runtime.yaw;
      runtime.desiredPitch = 0;
      settleCamera(runtime, 0, true);
      setSceneClass("completed-context");
      setSceneOrigin("completed");
      setSceneTitle("Room 02 · Generated continuation");
      setObservedPercent(0);
      setProviderUsed(room2?.completion === "provider");
      setCaptureSummary(room2?.sourceLabel ?? "doorway-conditioned procedural continuation");
      setActiveRoom(roomAfterPortalAction(activeRoom, "enter", portalPhase));
      setPortalGateOpen(false);
      setNotice(room2 ? roomProvenanceLabel(room2) : "Room 02 · local procedural completion · 0% observed");
      window.requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
    } finally {
      setIngesting(false);
    }
  };

  const returnToObservedRoom = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setIngesting(true);
    try {
      await installEnvironment(roomUrlsRef.current.observed);
      const entry = observedRoomRef.current;
      if (entry.sceneClass === "completed-context") {
        await buildProceduralRoom(roomLayerUrlsRef.current.observed, roomUrlsRef.current.observed, 1);
      } else {
        clearProceduralWorld(runtime);
      }
      runtime.sceneClass = entry.sceneClass;
      runtime.walkPosition.copy(runtime.entryPosition);
      runtime.yaw = 0;
      runtime.pitch = 0;
      runtime.desiredYaw = 0;
      runtime.desiredPitch = 0;
      settleCamera(runtime, 0, true);
      setSceneClass(entry.sceneClass);
      setSceneOrigin(entry.origin);
      setSceneTitle(entry.title);
      setObservedPercent(entry.coverage);
      setProviderUsed(roomRecords.room1.completion === "provider");
      setCaptureSummary(entry.summary);
      setActiveRoom(roomAfterPortalAction(activeRoom, "return", portalPhase));
      setPortalGateOpen(false);
      setNotice(entry.origin === "eso"
        ? "Returned to observed Room 01 · source-grounded 360° context"
        : completionDisclosure(
          entry.coverage,
          roomRecords.room1.completion === "provider",
          roomRecords.room1.registration,
        ));
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
    const atThreshold =
      runtime.sceneClass !== "imported-gaussian" &&
      runtime.walkPosition.z <= runtime.safeMin.z + 0.045 &&
      Math.abs(runtime.walkPosition.x) <= 0.19;
    if (atThreshold && !runtime.portalNear) {
      runtime.portalNear = true;
      setPortalPhase((phase) => nextPortalPhase(phase, "approach"));
      portalReturnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : stageRef.current;
      setPortalGateOpen(true);
      setNotice("Unmapped threshold reached · generate the next bounded room before entering");
    } else if (!atThreshold) {
      runtime.portalNear = false;
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
        <a className="capture-brand" href="#studio" aria-label="Spatial Forge home">
          <span>Image to world</span>
          <strong>Spatial Forge</strong>
        </a>
        <div className="scene-picker">
          <span>Scene</span>
          <select
            aria-label="Built-in spatial example"
            value={exampleId}
            disabled={ingesting}
            onChange={(event) => {
              const next = event.target.value as ExampleId;
              setExampleId(next);
              if (next === "eso") void restoreEsoScene();
              else if (next === "layered") void loadLayeredDemo();
              else if (next === "kitchen") void loadBundledGaussian();
            }}
          >
            <option value="eso">ESO photo room</option>
            <option value="layered">Layered capture demo</option>
            <option value="kitchen">AWS kitchen SOG</option>
            {exampleId === "procedural" && <option value="procedural">Current spatial preview</option>}
            {exampleId === "custom" && <option value="custom">Current custom scene</option>}
          </select>
          <i aria-label={`Rendering profile: ${renderProfile}`}>{renderProfile}</i>
        </div>
        <div className="capture-actions">
          <button type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={ingesting}>
            {ingesting ? "Building…" : "Create world"}
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
        ref={stageRef}
        className={`spatial-stage mode-${mode} ${dropActive ? "drop-active" : ""} ${ingesting || progress < 100 ? "scene-loading" : ""}`}
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
        {(ingesting || progress < 100) && (
          <div className="scene-loading-cover" role="status" aria-live="polite">
            <span>Spatial Forge</span>
            <strong>{ingesting ? "Preparing coherent room geometry" : "Loading photographic context"}</strong>
            <small>{Math.max(0, progress)}% ready</small>
            <i><em style={{ width: `${Math.max(3, progress)}%` }} /></i>
          </div>
        )}
        <div className="stage-scrim" aria-hidden="true" />

        <div className="scene-heading">
          <p>
            {sceneOrigin === "eso"
              ? "REAL SPATIAL RECORD · VITACURA, CHILE"
              : sceneOrigin === "spz"
                ? "TRAINED GAUSSIAN · ANISOTROPIC SPLAT SCENE"
                : sceneOrigin === "completed"
                  ? activeRoom === 1
                    ? "BOUNDED SPATIAL PREVIEW · OBSERVED + COMPLETED CONTEXT"
                    : "GENERATED ROOM 02 · DOORWAY-CONDITIONED CONTEXT"
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

        {sceneClass !== "imported-gaussian" && activeProvenance && (
          <aside className={`evidence-ribbon ${activeProvenance.registration}`} aria-label="Visible room provenance">
            <span>Evidence in view</span>
            <strong>{roomProvenanceLabel(activeProvenance)}</strong>
            <small>
              {activeProvenance.registration === "unregistered"
                ? "Pose unknown · depth cues provide perceptual parallax, not measured depth"
                : activeProvenance.registration === "procedural"
                  ? "Structurally generated continuation · not observed"
                  : "Source-grounded 360° context · limited translation"}
            </small>
          </aside>
        )}

        {sceneClass !== "imported-gaussian" && mode === "explore" && (
          <section className="world-route" aria-label="Procedural world route">
            <div className={`route-room ${activeRoom === 1 ? "active" : ""}`}>
              <i aria-hidden="true" />
              <span>Room 01</span>
              <strong>{roomOneObservedPercent}% observed</strong>
            </div>
            <div className={`route-link ${portalPhase === "ready" || activeRoom === 2 ? "ready" : ""}`} aria-hidden="true" />
            <div className={`route-room ${activeRoom === 2 ? "active" : ""} ${portalPhase === "idle" ? "pending" : ""}`}>
              <i aria-hidden="true" />
              <span>Room 02</span>
              <strong>{portalPhase === "ready" || activeRoom === 2 ? "completed" : "not generated"}</strong>
            </div>
            {activeRoom === 1 ? (
              <button
                ref={doorwayTriggerRef}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  approachDoorway();
                }}
                disabled={portalPhase === "generating"}
              >
                {portalPhase === "ready" ? "Room 02 ready" : "Approach doorway"}
              </button>
            ) : (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void returnToObservedRoom();
                }}
                disabled={ingesting}
              >
                Return to Room 01
              </button>
            )}
          </section>
        )}

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
              window.requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
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

        {activeRoom === 1 && portalGateOpen && portalPhase !== "idle" && sceneClass !== "imported-gaussian" && (
          <>
          <div
            className="portal-backdrop"
            aria-hidden="true"
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          />
          <section
            ref={portalDialogRef}
            className={`portal-gate ${portalPhase}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="portal-title"
            aria-describedby="portal-description"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape" && portalPhase !== "generating") {
                event.preventDefault();
                closePortalDialog();
                return;
              }
              if (event.key !== "Tab") return;
              const focusable = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])"),
              );
              if (!focusable.length) {
                event.preventDefault();
                event.currentTarget.focus();
                return;
              }
              const first = focusable[0];
              const last = focusable.at(-1)!;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <span className="portal-kicker">Unmapped threshold</span>
            <h2 id="portal-title">
              {portalPhase === "threshold" && "The next room does not exist yet"}
              {portalPhase === "generating" && "Generating a bounded continuation"}
              {portalPhase === "ready" && "Room 02 is ready to enter"}
            </h2>
            <p id="portal-description" aria-live="polite">
              {portalPhase === "threshold" && "Only Room 01 is currently supported. Generate context beyond this doorway before crossing."}
              {portalPhase === "generating" && GENERATION_STEPS[generationStep]}
              {portalPhase === "ready" && "The continuation is explicitly marked as completed context. It is explorable inside a new limited movement cell."}
            </p>
            {portalPhase === "generating" && (
              <div className="portal-progress" aria-label={`Generation step ${generationStep + 1} of ${GENERATION_STEPS.length}`}>
                {GENERATION_STEPS.map((step, index) => (
                  <i key={step} className={index <= generationStep ? "done" : ""} />
                ))}
              </div>
            )}
            <div className="portal-actions">
              {portalPhase === "threshold" && (
                <button ref={portalPrimaryRef} type="button" onClick={() => void generateBeyondDoorway()}>
                  Generate beyond doorway
                </button>
              )}
              {portalPhase === "ready" && (
                <button ref={portalPrimaryRef} type="button" onClick={() => void enterContinuation()}>
                  Enter Room 02
                </button>
              )}
              {portalPhase !== "generating" && (
                <button
                  type="button"
                  className="quiet"
                  onClick={closePortalDialog}
                >
                  Stay here
                </button>
              )}
            </div>
          </section>
          </>
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
                      : sceneOrigin === "completed"
                        ? captureSummary
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
                    : sceneOrigin === "completed"
                      ? "Completed equirectangular · 360°"
                    : manifest?.environment?.projection === "equirectangular"
                      ? "Equirectangular · 360°"
                      : "Source mosaic context"}
                </dd>
              </div>
              {sceneClass === "completed-context" && (
                <>
                  <div><dt>Evidence</dt><dd>{captureSummary}</dd></div>
                  <div><dt>Observed</dt><dd>{observedPercent}%</dd></div>
                  <div>
                    <dt>Registration</dt>
                    <dd>{activeProvenance?.registration === "unregistered" ? "Views unregistered" : "Procedural layout"}</dd>
                  </div>
                  <div>
                    <dt>Completion</dt>
                    <dd>
                      {activeProvenance?.completion === "provider"
                        ? "Configured provider"
                        : activeProvenance?.completion === "procedural-local"
                          ? "Local procedural completion"
                          : "Deterministic local fill"}
                    </dd>
                  </div>
                  <div><dt>Geometry</dt><dd>Non-metric bounded context</dd></div>
                </>
              )}
              <div>
                <dt>{sceneOrigin === "spz" || sceneOrigin === "completed" ? "Renderer" : "Proxy points"}</dt>
                <dd>
                  {sceneOrigin === "spz"
                    ? "Spark 2.1 · local decode"
                    : sceneOrigin === "completed"
                      ? "Three.js · 4K context sphere"
                      : manifest?.point_count.toLocaleString() ?? "108,656"}
                </dd>
              </div>
            </dl>
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

        {dropActive && <div className="capture-drop"><strong>Drop images, video, or a trained SPZ/SOG</strong><span>Media becomes an on-device bounded preview with explicit completion labels. SPZ/SOG opens as trained Gaussian data.</span></div>}
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
