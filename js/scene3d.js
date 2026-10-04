// A three.js scene rendered *inside* the MapLibre GL context as a custom layer, so the explorer and the
// quest beacons share the map's camera, perspective, depth buffer and horizon fog. This is what makes the
// avatar stand on the map instead of floating over it as a separate overlay.
//
// Coordinates inside the scene are metres relative to the player: +x east, +y up, -z north.

const EXAGGERATION = 4.2;         // a little bigger than life so he reads on a phone, but still smaller than a building
const REAL_HEIGHT_M = 1.75;
const STATUS_COLOR = { locked: 0x6b7390, open: 0x4285f4, near: 0xfbbc05, cleared: 0x34a853 };
const BEAM_HEIGHT = 90;
const CUBE_HEIGHT = 14;

function gradientTexture(THREE, vertical) {
  const canvas = document.createElement('canvas');
  canvas.width = 4; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, vertical ? '#000' : '#fff'); g.addColorStop(1, vertical ? '#fff' : '#000');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(canvas);
}

export async function createScene3D(maplibregl) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const cache = new Map();

  const camera = new THREE.Camera();
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xf0f5ff, 0x4a5a9a, 2.1);
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
  scene.add(hemi, sun);

  const world = new THREE.Group();   // everything that is positioned relative to the player
  scene.add(world);

  // ----- explorer -----
  const avatarRoot = new THREE.Group();
  world.add(avatarRoot);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 64), new THREE.MeshBasicMaterial({ color: 0x4285f4, transparent: true, opacity: 0.9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.0, 64), new THREE.MeshBasicMaterial({ color: 0x4285f4, transparent: true, opacity: 0.16, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.04;
  const ringGroup = new THREE.Group();
  ringGroup.add(ring, disc);
  world.add(ringGroup);

  let mixer = null;
  let actions = {};
  let currentAction = null;
  let currentKind = null;
  let model = null;

  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false });
  shadowMaterial.stencilWrite = true;
  shadowMaterial.stencilFunc = THREE.EqualStencilFunc;
  shadowMaterial.stencilRef = 0;
  shadowMaterial.stencilZPass = THREE.IncrementStencilOp;

  async function loadKind(kind) {
    if (!cache.has(kind)) cache.set(kind, loader.loadAsync(`./assets/player-${kind}.glb`));
    return cache.get(kind);
  }

  async function setAvatarKind(kind) {
    if (kind === currentKind) return;
    currentKind = kind;
    const gltf = await loadKind(kind);
    if (kind !== currentKind) return; // a newer choice arrived while loading
    if (model) avatarRoot.remove(model);
    // SkinnedMesh clones must be re-bound to cloned bones.
    const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
    model = SkeletonUtils.clone(gltf.scene);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y || 1;
    const s = (REAL_HEIGHT_M * EXAGGERATION) / height;
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; if (o.material) o.material.side = THREE.FrontSide; } });
    avatarRoot.add(model);
    mixer = new THREE.AnimationMixer(model);
    actions = Object.fromEntries(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)]));
    currentAction = null;
    setAnimation(lastAnim || 'CharacterArmature|Idle', true);
    ringGroup.scale.setScalar(REAL_HEIGHT_M * EXAGGERATION * 0.55);
  }

  let lastAnim = null;
  function setAnimation(name, immediate) {
    lastAnim = name;
    const next = actions[name];
    if (!next || next === currentAction) return;
    next.reset().play();
    if (currentAction && !immediate) next.crossFadeFrom(currentAction, 0.25, false);
    else if (currentAction) currentAction.stop();
    currentAction = next;
  }

  // ----- quest beacons -----
  const beacons = new Map();
  const beamAlpha = gradientTexture(THREE, true);
  function makeBeacon(stop) {
    const group = new THREE.Group();
    const color = new THREE.Color(STATUS_COLOR.open);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, BEAM_HEIGHT, 16, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, alphaMap: beamAlpha, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = BEAM_HEIGHT / 2;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(4.5, 4.5, 4.5), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1 }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    cube.add(edges);
    const zone = new THREE.Mesh(new THREE.CircleGeometry(stop.radius || 50, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.045, depthWrite: false }));
    zone.rotation.x = -Math.PI / 2; zone.position.y = 0.03;
    const zoneEdge = new THREE.Mesh(new THREE.RingGeometry((stop.radius || 50) - 0.5, stop.radius || 50, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
    zoneEdge.rotation.x = -Math.PI / 2; zoneEdge.position.y = 0.05;
    const base = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.4, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    base.rotation.x = -Math.PI / 2; base.position.y = 0.06;
    group.add(beam, cube, zone, zoneEdge, base);
    world.add(group);
    return { stop, group, cube, beam, zone, zoneEdge, base, status: 'open', phase: Math.random() * 6 };
  }

  const state = { origin: null, heading: 0, bearing: 0, selected: null, stops: [] };
  let projection = new THREE.Matrix4();
  let lastTime = performance.now();
  let map; let renderer; let size = { w: 1, h: 1 };

  const tmpV = new THREE.Vector4();
  function toScreen(x, y, z) {
    tmpV.set(x, y, z, 1).applyMatrix4(projection);
    if (tmpV.w <= 0) return null;
    return { x: ((tmpV.x / tmpV.w) + 1) / 2 * size.w, y: (1 - (tmpV.y / tmpV.w)) / 2 * size.h, depth: tmpV.w };
  }

  const layer = {
    id: 'scene3d', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      map = m;
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
    },
    render(gl, args) {
      const o = state.origin;
      if (!o) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const t = now / 1000;

      const merc = maplibregl.MercatorCoordinate.fromLngLat([o.lng, o.lat], 0);
      const s = merc.meterInMercatorCoordinateUnits();
      projection = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix)
        .multiply(new THREE.Matrix4().makeTranslation(merc.x, merc.y, merc.z))
        .multiply(new THREE.Matrix4().makeScale(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix.copy(projection);
      camera.projectionMatrixInverse.copy(projection).invert();
      size = { w: m_canvasCssWidth(), h: m_canvasCssHeight() };

      // face the way we walk: model faces +z (south) at rotation 0, heading is clockwise from north
      avatarRoot.rotation.y = Math.PI - (state.heading * Math.PI) / 180;
      mixer?.update(dt);

      // Light stays fixed relative to the *camera* (from behind-above-right) so the explorer reads well at any heading.
      const b = (state.bearing * Math.PI) / 180;
      const fwd = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b));
      const right = new THREE.Vector3(Math.cos(b), 0, Math.sin(b));
      const lightDir = new THREE.Vector3().addScaledVector(fwd, -0.55).addScaledVector(right, 0.7).setY(1.1).normalize();
      sun.position.copy(lightDir.clone().multiplyScalar(100));

      ringGroup.position.set(0, 0, 0);
      const pulse = 1 + Math.sin(t * 2.4) * 0.04;
      const base = REAL_HEIGHT_M * EXAGGERATION * 0.55;
      ringGroup.scale.setScalar(base * pulse);

      beacons.forEach((bk) => {
        const east = (bk.stop.lng - o.lng) * 111320 * Math.cos((o.lat * Math.PI) / 180);
        const north = (bk.stop.lat - o.lat) * 110574;
        bk.group.position.set(east, 0, -north);
        bk.cube.position.y = CUBE_HEIGHT + Math.sin(t * 1.6 + bk.phase) * 1.2;
        bk.cube.rotation.y = t * 0.9 + bk.phase;
        bk.cube.rotation.x = 0.35;
        const sel = state.selected === bk.stop.id;
        bk.cube.scale.setScalar(sel ? 1.25 : 1);
        bk.base.scale.setScalar(1 + Math.sin(t * 2 + bk.phase) * 0.06);
        bk.beam.visible = bk.status !== 'cleared';
        // Fade a beacon out as the explorer walks into it, so the pillar and cube never hide the character.
        const near = Math.min(1, Math.max(0, (Math.hypot(east, north) - 8) / 40));
        bk.beam.material.opacity = (bk.status === 'locked' ? 0.22 : 0.55) * (0.15 + 0.85 * near);
        bk.cube.material.transparent = true;
        bk.cube.material.opacity = 0.3 + 0.7 * near;
      });

      renderer.resetState();
      // 1) planar shadow: flatten the explorer onto the ground along the light direction, one stencil-guarded pass
      if (model) {
        const L = lightDir;
        const flat = new THREE.Matrix4().set(
          L.y, -L.x, 0, 0,
          0, 0, 0, 0,
          0, -L.z, L.y, 0,
          0, 0, 0, L.y);
        const lift = new THREE.Matrix4().makeTranslation(0, 0.06, 0);
        camera.projectionMatrix.copy(projection).multiply(lift).multiply(flat);
        const saved = scene.children.map((c) => c.visible);
        scene.children.forEach((c) => { c.visible = c === world; });
        world.children.forEach((c) => { c.visible = c === avatarRoot; });
        scene.overrideMaterial = shadowMaterial;
        gl.clear(gl.STENCIL_BUFFER_BIT);
        renderer.render(scene, camera);
        scene.overrideMaterial = null;
        scene.children.forEach((c, i) => { c.visible = saved[i]; });
        world.children.forEach((c) => { c.visible = true; });
        gl.clear(gl.STENCIL_BUFFER_BIT);
        renderer.resetState();
        camera.projectionMatrix.copy(projection);
      }
      // 2) the actual scene
      renderer.render(scene, camera);
      map.triggerRepaint();
    },
  };

  function m_canvasCssWidth() { return map.getCanvas().clientWidth; }
  function m_canvasCssHeight() { return map.getCanvas().clientHeight; }

  return {
    layer,
    setAvatarKind,
    setAnimation,
    setStops(stops) {
      beacons.forEach((bk) => world.remove(bk.group));
      beacons.clear();
      stops.forEach((stop) => beacons.set(stop.id, makeBeacon(stop)));
    },
    /** statuses: { stopId: 'locked' | 'open' | 'near' | 'cleared' } */
    setStatuses(statuses, selectedId) {
      state.selected = selectedId;
      beacons.forEach((bk, id) => {
        const status = statuses[id] || 'open';
        if (bk.status === status) return;
        bk.status = status;
        const color = new THREE.Color(STATUS_COLOR[status]);
        bk.beam.material.color.copy(color);
        bk.cube.material.color.copy(color); bk.cube.material.emissive.copy(color);
        bk.zone.material.color.copy(color); bk.zoneEdge.material.color.copy(color); bk.base.material.color.copy(color);
      });
    },
    update(next) { Object.assign(state, next); },
    /** Screen positions of every beacon's floating cube, for labels and tap picking. */
    beaconScreen() {
      const o = state.origin;
      if (!o) return [];
      return [...beacons.values()].map((bk) => {
        const p = toScreen(bk.group.position.x, CUBE_HEIGHT, bk.group.position.z);
        const dx = bk.group.position.x; const dz = bk.group.position.z;
        return { id: bk.stop.id, dist: Math.hypot(dx, dz), ...(p || { x: -999, y: -999, depth: -1 }), visible: Boolean(p) };
      });
    },
  };
}
