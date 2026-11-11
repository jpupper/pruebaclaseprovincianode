/**
 * Minecraft 3D Voxel Editor - Cliente
 * Three.js + Socket.io
 */

// Estado global de la aplicación
const AppState = {
  currentTool: 'place', // 'place' | 'erase'
  cameraMode: 'build',  // 'build' | 'orbit'
  currentColor: '#2ecc71',
  blocks: new Map(),    // key: "x,y,z" -> { mesh, color, edges }
  myUser: null,
  connectedUsers: [],
  remoteCursors: new Map() // socketId -> mesh
};

// ==========================================
// 1. CONFIGURACIÓN DE THREE.JS
// ==========================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f141c);
scene.fog = new THREE.FogExp2(0x0f141c, 0.015);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(12, 14, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// Controles de Cámara (OrbitControls)
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.02; // No bajar del suelo
controls.minDistance = 3;
controls.maxDistance = 120;

// Configurar qué botón de ratón usa OrbitControls
function updateControlsMapping() {
  if (AppState.cameraMode === 'orbit') {
    // Modo inspección: Clic izquierdo rota libremente
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };
  } else {
    // Modo construcción: Clic derecho rota para dejar clic izquierdo a los bloques
    controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE
    };
  }
}
updateControlsMapping();

// Luces
const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
dirLight.position.set(25, 40, 20);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 150;
const d = 30;
dirLight.shadow.camera.left = -d;
dirLight.shadow.camera.right = d;
dirLight.shadow.camera.top = d;
dirLight.shadow.camera.bottom = -d;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);

const hemiLight = new THREE.HemisphereLight(0x4488bb, 0x1a2332, 0.35);
scene.add(hemiLight);

// Suelo y Rejilla (Grid)
const GRID_SIZE = 40;
const gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x3b82f6, 0x1e293b);
gridHelper.position.y = -0.01;
scene.add(gridHelper);

// Plano invisible para Raycasting en el suelo
const planeGeo = new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE);
planeGeo.rotateX(-Math.PI / 2);
const planeMat = new THREE.MeshBasicMaterial({ visible: false });
const groundPlane = new THREE.Mesh(planeGeo, planeMat);
scene.add(groundPlane);

// Geometría y materiales de cubos
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const boxEdgesGeo = new THREE.EdgesGeometry(boxGeometry);
const edgeLineMaterial = new THREE.LineBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.25,
  linewidth: 1
});

// Cubo de previsualización (Roll-over mesh)
const rollOverGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
const rollOverMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(AppState.currentColor),
  opacity: 0.55,
  transparent: true
});
const rollOverMesh = new THREE.Mesh(rollOverGeo, rollOverMat);
const rollOverEdges = new THREE.LineSegments(
  boxEdgesGeo,
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })
);
rollOverMesh.add(rollOverEdges);
rollOverMesh.visible = false;
scene.add(rollOverMesh);

// Raycaster para detectar puntero
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const interactableObjects = [groundPlane];

// ==========================================
// 2. GESTIÓN DE CUBOS EN ESCENA
// ==========================================
function getBlockKey(x, y, z) {
  return `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
}

function createVoxelMesh(x, y, z, colorHex) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    roughness: 0.4,
    metalness: 0.1
  });
  const mesh = new THREE.Mesh(boxGeometry, material);
  mesh.position.set(x, y + 0.5, z); // centrado sobre la celda
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Bordes sutiles para look voxel definido
  const edges = new THREE.LineSegments(boxEdgesGeo, edgeLineMaterial);
  mesh.add(edges);

  // Metadata para raycast
  mesh.userData = { gridX: x, gridY: y, gridZ: z, color: colorHex };
  return mesh;
}

function addBlock(x, y, z, colorHex, emitSocket = true) {
  const key = getBlockKey(x, y, z);
  if (AppState.blocks.has(key)) return;

  const mesh = createVoxelMesh(x, y, z, colorHex);
  scene.add(mesh);
  interactableObjects.push(mesh);
  AppState.blocks.set(key, { mesh, color: colorHex, x, y, z });

  updateCubeCounter();

  if (emitSocket && socket.connected) {
    socket.emit('place-block', { x, y, z, color: colorHex });
  }
}

function removeBlock(x, y, z, emitSocket = true) {
  const key = getBlockKey(x, y, z);
  const block = AppState.blocks.get(key);
  if (!block) return;

  scene.remove(block.mesh);
  const idx = interactableObjects.indexOf(block.mesh);
  if (idx > -1) interactableObjects.splice(idx, 1);

  if (block.mesh.geometry) block.mesh.geometry.dispose();
  if (block.mesh.material) block.mesh.material.dispose();

  AppState.blocks.delete(key);
  updateCubeCounter();

  if (emitSocket && socket.connected) {
    socket.emit('remove-block', { x, y, z });
  }
}

function clearAllBlocks(emitSocket = true) {
  AppState.blocks.forEach((block) => {
    scene.remove(block.mesh);
  });
  AppState.blocks.clear();

  // Restablecer array de interacción solo al suelo
  interactableObjects.length = 0;
  interactableObjects.push(groundPlane);

  updateCubeCounter();

  if (emitSocket && socket.connected) {
    socket.emit('clear-world');
  }
}

function loadBlocksArray(blocksArray) {
  clearAllBlocks(false);
  if (!Array.isArray(blocksArray)) return;

  blocksArray.forEach((b) => {
    addBlock(b.x, b.y, b.z, b.color, false);
  });
}

function updateCubeCounter() {
  const countEl = document.getElementById('cube-count');
  if (countEl) countEl.textContent = AppState.blocks.size;
}

// ==========================================
// 3. INTERACCIÓN DE RATÓN / PUNTERO
// ==========================================
let pointerDownPos = { x: 0, y: 0 };
let isMouseDown = false;

function updateRollOverPreview() {
  if (AppState.cameraMode === 'orbit') {
    rollOverMesh.visible = false;
    return;
  }

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactableObjects, false);

  if (intersects.length > 0) {
    const intersect = intersects[0];

    if (AppState.currentTool === 'place') {
      // Calcular posición del nuevo bloque
      const position = new THREE.Vector3();
      if (intersect.object === groundPlane) {
        position.set(
          Math.floor(intersect.point.x + 0.5),
          0.5,
          Math.floor(intersect.point.z + 0.5)
        );
      } else {
        position.copy(intersect.object.position).add(intersect.face.normal);
      }

      // Validar límites
      if (position.y >= 0.5) {
        rollOverMesh.position.copy(position);
        rollOverMat.color.set(AppState.currentColor);
        rollOverMat.opacity = 0.55;
        rollOverEdges.material.color.setHex(0xffffff);
        rollOverMesh.visible = true;

        // Emitir posición de cursor a los demás
        throttledSendCursor(position.x, position.y - 0.5, position.z);
        return;
      }
    } else if (AppState.currentTool === 'erase') {
      // Modo borrador: resaltar en rojo si apuntamos a un cubo existente
      if (intersect.object !== groundPlane) {
        rollOverMesh.position.copy(intersect.object.position);
        rollOverMat.color.setHex(0xef4444);
        rollOverMat.opacity = 0.65;
        rollOverEdges.material.color.setHex(0xff0000);
        rollOverMesh.visible = true;
        return;
      }
    }
  }

  rollOverMesh.visible = false;
}

// Throttle para enviar cursor multijugador
let lastCursorTime = 0;
function throttledSendCursor(x, y, z) {
  const now = Date.now();
  if (now - lastCursorTime > 60 && socket.connected) {
    lastCursorTime = now;
    socket.emit('cursor-move', { x, y, z });
  }
}

// Event Listeners de ventana y canvas
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.domElement.addEventListener('pointermove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  updateRollOverPreview();
});

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDownPos = { x: event.clientX, y: event.clientY };
  isMouseDown = true;
});

renderer.domElement.addEventListener('pointerup', (event) => {
  isMouseDown = false;

  // Evitar construir si el usuario estaba arrastrando para rotar la cámara
  const dist = Math.hypot(event.clientX - pointerDownPos.x, event.clientY - pointerDownPos.y);
  if (dist > 5) return;

  // Si está en modo inspección pura, no colocar bloques con clic
  if (AppState.cameraMode === 'orbit') return;

  // Solo responder al clic izquierdo (button === 0)
  if (event.button !== 0) return;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactableObjects, false);

  if (intersects.length > 0) {
    const intersect = intersects[0];

    if (AppState.currentTool === 'place') {
      let x, y, z;
      if (intersect.object === groundPlane) {
        x = Math.floor(intersect.point.x + 0.5);
        y = 0;
        z = Math.floor(intersect.point.z + 0.5);
      } else {
        const targetPos = new THREE.Vector3().copy(intersect.object.position).add(intersect.face.normal);
        x = targetPos.x;
        y = Math.round(targetPos.y - 0.5);
        z = targetPos.z;
      }

      if (y >= 0 && Math.abs(x) <= GRID_SIZE / 2 && Math.abs(z) <= GRID_SIZE / 2) {
        addBlock(x, y, z, AppState.currentColor, true);
        updateRollOverPreview();
      }
    } else if (AppState.currentTool === 'erase') {
      if (intersect.object !== groundPlane && intersect.object.userData) {
        const { gridX, gridY, gridZ } = intersect.object.userData;
        removeBlock(gridX, gridY, gridZ, true);
        updateRollOverPreview();
      }
    }
  }
});

// ==========================================
// 4. CURSORES DE JUGADORES REMOTOS
// ==========================================
function updateRemoteCursor(userId, name, color, pos) {
  if (!pos) return;
  let cursor = AppState.remoteCursors.get(userId);

  if (!cursor) {
    const markerGeo = new THREE.BoxGeometry(1.05, 1.05, 1.05);
    const markerMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      wireframe: true,
      transparent: true,
      opacity: 0.8
    });
    cursor = new THREE.Mesh(markerGeo, markerMat);
    scene.add(cursor);
    AppState.remoteCursors.set(userId, cursor);
  }

  cursor.position.set(pos.x, pos.y + 0.5, pos.z);
  cursor.visible = true;
}

function removeRemoteCursor(userId) {
  const cursor = AppState.remoteCursors.get(userId);
  if (cursor) {
    scene.remove(cursor);
    AppState.remoteCursors.delete(userId);
  }
}

// ==========================================
// 5. ANIMACIÓN Y RENDER LOOP
// ==========================================
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ==========================================
// 6. UI Y SELECTORES
// ==========================================
const toolPlaceBtn = document.getElementById('tool-place');
const toolEraseBtn = document.getElementById('tool-erase');
const modeBuildBtn = document.getElementById('mode-build-cam');
const modeOrbitBtn = document.getElementById('mode-orbit-only');
const colorInput = document.getElementById('cube-color-input');
const colorHexInput = document.getElementById('cube-color-hex');
const colorPreviewSample = document.getElementById('color-preview-sample');
const paletteGrid = document.getElementById('palette-grid');
const btnResetCam = document.getElementById('btn-reset-cam');
const btnClearWorld = document.getElementById('btn-clear-world');

// Selector de herramientas (Colocar / Borrar)
function setTool(tool) {
  AppState.currentTool = tool;
  toolPlaceBtn.classList.toggle('active', tool === 'place');
  toolEraseBtn.classList.toggle('active', tool === 'erase');
  updateRollOverPreview();
}

toolPlaceBtn.addEventListener('click', () => setTool('place'));
toolEraseBtn.addEventListener('click', () => setTool('erase'));

// Modo de Cámara (Construcción vs Inspección)
modeBuildBtn.addEventListener('click', () => {
  AppState.cameraMode = 'build';
  modeBuildBtn.classList.add('active');
  modeOrbitBtn.classList.remove('active');
  updateControlsMapping();
  updateRollOverPreview();
});

modeOrbitBtn.addEventListener('click', () => {
  AppState.cameraMode = 'orbit';
  modeOrbitBtn.classList.add('active');
  modeBuildBtn.classList.remove('active');
  updateControlsMapping();
  updateRollOverPreview();
});

// Manejo de Colores
function applyColor(color) {
  AppState.currentColor = color;
  colorInput.value = color;
  colorHexInput.value = color.toUpperCase();
  colorPreviewSample.style.backgroundColor = color;
  rollOverMat.color.set(color);

  // Actualizar estado activo en la paleta
  document.querySelectorAll('.palette-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color.toLowerCase() === color.toLowerCase());
  });
}

colorInput.addEventListener('input', (e) => applyColor(e.target.value));
colorHexInput.addEventListener('change', (e) => {
  let val = e.target.value.trim();
  if (!val.startsWith('#')) val = '#' + val;
  if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
    applyColor(val);
  } else {
    e.target.value = AppState.currentColor;
  }
});

paletteGrid.addEventListener('click', (e) => {
  const swatch = e.target.closest('.palette-swatch');
  if (swatch) {
    applyColor(swatch.dataset.color);
  }
});

// Reiniciar Cámara
btnResetCam.addEventListener('click', () => {
  controls.reset();
  camera.position.set(12, 14, 18);
  controls.target.set(0, 1, 0);
  showToast('📷 Cámara restablecida');
});

// Vaciar Escena
btnClearWorld.addEventListener('click', () => {
  if (AppState.blocks.size === 0) {
    showToast('La escena ya está vacía');
    return;
  }
  if (confirm('¿Deseas vaciar todos los cubos de la escena? Esto afectará a todos los jugadores.')) {
    clearAllBlocks(true);
    showToast('🗑️ Escena vaciada');
  }
});

// Atajos de teclado
window.addEventListener('keydown', (e) => {
  // Ignorar si el foco está en un input
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

  if (e.key === '1' || e.key.toLowerCase() === 'b') {
    setTool('place');
  } else if (e.key === '2' || e.key.toLowerCase() === 'e') {
    setTool('erase');
  } else if (e.key.toLowerCase() === 'c') {
    if (AppState.cameraMode === 'build') modeOrbitBtn.click();
    else modeBuildBtn.click();
  }
});

// Tabs del panel derecho
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    tabContents.forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    const targetId = btn.dataset.tab;
    const targetContent = document.getElementById(targetId);
    if (targetContent) targetContent.classList.add('active');
  });
});

// ==========================================
// 7. GESTIÓN DE PRESETS (SERVIDOR)
// ==========================================
const presetNameInput = document.getElementById('preset-name-input');
const btnSavePreset = document.getElementById('btn-save-preset');
const btnRefreshPresets = document.getElementById('btn-refresh-presets');
const presetsListContainer = document.getElementById('presets-list');

async function fetchPresets() {
  try {
    const res = await fetch('/api/presets');
    const data = await res.json();
    if (data.success) {
      renderPresetsList(data.presets);
    }
  } catch (err) {
    console.error('Error al cargar presets:', err);
    presetsListContainer.innerHTML = '<div class="empty-state">Error cargando presets</div>';
  }
}

function renderPresetsList(presets) {
  if (!presets || presets.length === 0) {
    presetsListContainer.innerHTML = '<div class="empty-state">No hay composiciones guardadas aún. ¡Crea una y haz clic en Guardar!</div>';
    return;
  }

  presetsListContainer.innerHTML = '';
  presets.forEach((preset) => {
    const card = document.createElement('div');
    card.className = 'preset-card';

    const dateStr = new Date(preset.createdAt).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });

    card.innerHTML = `
      <div class="preset-info">
        <span class="preset-name">${escapeHtml(preset.name)}</span>
        <span class="preset-blocks">${preset.blockCount} cubos</span>
      </div>
      <div class="preset-actions">
        <small style="margin-right:auto;font-size:0.7rem;color:#64748b;">${dateStr}</small>
        <button class="btn btn-secondary btn-sm btn-load" data-id="${preset.id}">📂 Cargar</button>
        <button class="btn btn-danger btn-sm btn-del" data-id="${preset.id}" title="Eliminar preset">🗑️</button>
      </div>
    `;

    // Evento cargar
    card.querySelector('.btn-load').addEventListener('click', () => loadPresetFromServer(preset.id));
    // Evento eliminar
    card.querySelector('.btn-del').addEventListener('click', () => deletePresetFromServer(preset.id, preset.name));

    presetsListContainer.appendChild(card);
  });
}

async function loadPresetFromServer(presetId) {
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(presetId)}`);
    const data = await res.json();
    if (data.success && data.preset) {
      // Cargar localmente
      loadBlocksArray(data.preset.blocks);
      // Sincronizar con el servidor y otros jugadores
      if (socket.connected) {
        socket.emit('load-preset', data.preset);
      }
      showToast(`✨ Preset "${data.preset.name}" cargado`);
    } else {
      showToast('Error al cargar el preset');
    }
  } catch (err) {
    console.error(err);
    showToast('Error de conexión al cargar preset');
  }
}

async function saveCurrentPreset() {
  const name = presetNameInput.value.trim();
  if (!name) {
    showToast('⚠️ Ingresa un nombre para el preset');
    presetNameInput.focus();
    return;
  }

  if (AppState.blocks.size === 0) {
    showToast('⚠️ No puedes guardar una composición vacía');
    return;
  }

  const blocksArray = Array.from(AppState.blocks.values()).map((b) => ({
    x: b.x,
    y: b.y,
    z: b.z,
    color: b.color
  }));

  try {
    btnSavePreset.disabled = true;
    btnSavePreset.textContent = 'Guardando...';

    const res = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, blocks: blocksArray })
    });
    const data = await res.json();

    if (data.success) {
      showToast(`💾 Preset "${name}" guardado en el servidor!`);
      presetNameInput.value = '';
      fetchPresets();
    } else {
      showToast(`Error: ${data.error || 'No se pudo guardar'}`);
    }
  } catch (err) {
    console.error(err);
    showToast('Error de conexión al guardar');
  } finally {
    btnSavePreset.disabled = false;
    btnSavePreset.textContent = '💾 Guardar';
  }
}

async function deletePresetFromServer(presetId, presetName) {
  if (!confirm(`¿Estás seguro de eliminar el preset "${presetName}"?`)) return;

  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(presetId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      showToast(`🗑️ Preset eliminado`);
      fetchPresets();
    }
  } catch (err) {
    console.error(err);
    showToast('Error al eliminar preset');
  }
}

btnSavePreset.addEventListener('click', saveCurrentPreset);
presetNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveCurrentPreset();
});
btnRefreshPresets.addEventListener('click', () => {
  fetchPresets();
  showToast('🔄 Lista de presets actualizada');
});

// ==========================================
// 8. MULTIJUGADOR SOCKET.IO
// ==========================================
const socket = io();

const myAvatarDot = document.getElementById('my-avatar-dot');
const myNameInput = document.getElementById('my-name-input');
const btnUpdateName = document.getElementById('btn-update-name');
const usersListContainer = document.getElementById('users-list');
const onlineCountEl = document.getElementById('online-count');
const tabPlayerCount = document.getElementById('tab-player-count');

// Recibir estado inicial
socket.on('init-world', (data) => {
  AppState.myUser = data.user;

  // Actualizar UI de usuario local
  myAvatarDot.style.backgroundColor = data.user.color;
  myNameInput.value = data.user.name;

  // Cargar bloques actuales del mundo compartido
  loadBlocksArray(data.blocks);

  // Actualizar lista de jugadores y presets
  updateUsersUI(data.users);
  renderPresetsList(data.presets);

  showToast(`👋 Conectado como ${data.user.name}`);
});

// Actualización de lista de usuarios
socket.on('users-update', (users) => {
  AppState.connectedUsers = users;
  updateUsersUI(users);
});

socket.on('user-joined', (user) => {
  showToast(`🟢 ${user.name} se unió al editor`);
});

socket.on('user-left', (user) => {
  showToast(`🔴 ${user.name} salió`);
  removeRemoteCursor(user.id);
});

// Actualizaciones de bloques en tiempo real
socket.on('block-placed', (data) => {
  addBlock(data.block.x, data.block.y, data.block.z, data.block.color, false);
});

socket.on('block-removed', (data) => {
  removeBlock(data.x, data.y, data.z, false);
});

socket.on('world-cleared', (data) => {
  clearAllBlocks(false);
  showToast(`🧹 ${data.userName} vació la escena`);
});

socket.on('world-synced', (data) => {
  loadBlocksArray(data.blocks);
  showToast(`📦 ${data.loadedBy} cargó el preset "${data.presetName}"`);
});

// Notificación de presets actualizados en el servidor
socket.on('presets-updated', (presets) => {
  renderPresetsList(presets);
});

// Punteros y cursores remotos
socket.on('player-cursor', (data) => {
  updateRemoteCursor(data.userId, data.userName, data.color, data.position);
});

socket.on('player-cursor-remove', (data) => {
  removeRemoteCursor(data.userId);
});

// Cambiar nombre local
btnUpdateName.addEventListener('click', () => {
  const newName = myNameInput.value.trim();
  if (newName && socket.connected) {
    socket.emit('change-name', newName);
    showToast(`Nombre actualizado a: ${newName}`);
  }
});

myNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnUpdateName.click();
});

function updateUsersUI(users) {
  if (!users) return;
  const count = users.length;
  onlineCountEl.textContent = count;
  tabPlayerCount.textContent = count;

  usersListContainer.innerHTML = '';
  users.forEach((u) => {
    const isMe = AppState.myUser && u.id === AppState.myUser.id;
    const item = document.createElement('div');
    item.className = 'user-item';
    item.innerHTML = `
      <span class="user-avatar-dot" style="background-color: ${u.color};"></span>
      <span class="user-name">${escapeHtml(u.name)}</span>
      ${isMe ? '<span class="user-badge-you">Tú</span>' : ''}
    `;
    usersListContainer.appendChild(item);
  });
}

// ==========================================
// 9. UTILIDADES
// ==========================================
function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inicializar lista de presets al cargar
fetchPresets();

