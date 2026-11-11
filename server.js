const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = process.env.PORT || 3000;
const PRESETS_DIR = path.join(__dirname, 'presets');

// Asegurar que exista el directorio de presets
if (!fs.existsSync(PRESETS_DIR)) {
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Estado del mundo en memoria (clave: "x,y,z", valor: { x, y, z, color })
const worldBlocks = new Map();

// Clientes conectados: Map<socketId, { id, name, color }>
const connectedUsers = new Map();

const DEFAULT_NAMES = [
  'Steve', 'Alex', 'Herobrine', 'CreeperCraft', 'MinerPro',
  'PixelMaster', 'BlockBuilder', 'CubeKing', 'VoxelNinja', 'CraftyFox'
];

const USER_COLORS = [
  '#FF5722', '#4CAF50', '#2196F3', '#9C27B0', '#FF9800',
  '#00BCD4', '#E91E63', '#3F51B5', '#009688', '#FFC107'
];

function getRandomUserColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

function getRandomUserName() {
  const base = DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${base}_${num}`;
}

// Helpers para Presets
function getPresetList() {
  try {
    const files = fs.readdirSync(PRESETS_DIR);
    const presets = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const filePath = path.join(PRESETS_DIR, file);
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          presets.push({
            id: path.basename(file, '.json'),
            name: data.name || path.basename(file, '.json'),
            blockCount: Array.isArray(data.blocks) ? data.blocks.length : 0,
            createdAt: data.createdAt || fs.statSync(filePath).mtime.toISOString()
          });
        } catch (err) {
          console.error(`Error leyendo preset ${file}:`, err.message);
        }
      }
    }

    // Ordenar de más reciente a más antiguo
    return presets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (err) {
    console.error('Error listando presets:', err);
    return [];
  }
}

// API REST: Listar todos los presets
app.get('/api/presets', (req, res) => {
  res.json({ success: true, presets: getPresetList() });
});

// API REST: Obtener un preset por ID
app.get('/api/presets/:id', (req, res) => {
  const safeId = path.basename(req.params.id);
  const filePath = path.join(PRESETS_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Preset no encontrado' });
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    res.json({ success: true, preset: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API REST: Guardar nuevo preset
app.post('/api/presets', (req, res) => {
  const { name, blocks } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'El nombre del preset es requerido' });
  }
  if (!Array.isArray(blocks)) {
    return res.status(400).json({ success: false, error: 'Lista de cubos inválida' });
  }

  // Generar un ID seguro basado en nombre y timestamp
  const cleanName = name.trim().replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_');
  const id = `${cleanName || 'preset'}_${Date.now()}`;
  const filePath = path.join(PRESETS_DIR, `${id}.json`);

  const presetData = {
    id,
    name: name.trim(),
    createdAt: new Date().toISOString(),
    blocks: blocks.map(b => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
      z: Math.round(b.z),
      color: b.color || '#2ecc71'
    }))
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(presetData, null, 2), 'utf8');
    console.log(`[Preset Guardado] "${presetData.name}" (${presetData.blocks.length} cubos)`);
    // Notificar a todos los clientes que la lista de presets se actualizó
    io.emit('presets-updated', getPresetList());
    res.json({ success: true, preset: presetData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API REST: Eliminar preset
app.delete('/api/presets/:id', (req, res) => {
  const safeId = path.basename(req.params.id);
  const filePath = path.join(PRESETS_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Preset no encontrado' });
  }

  try {
    fs.unlinkSync(filePath);
    io.emit('presets-updated', getPresetList());
    res.json({ success: true, message: 'Preset eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manejo de WebSockets (Multijugador en tiempo real)
io.on('connection', (socket) => {
  const user = {
    id: socket.id,
    name: getRandomUserName(),
    color: getRandomUserColor()
  };

  connectedUsers.set(socket.id, user);
  console.log(`[Conexión] Usuario conectado: ${user.name} (${socket.id}). Total: ${connectedUsers.size}`);

  // Enviar estado inicial al usuario que se acaba de conectar
  socket.emit('init-world', {
    user,
    blocks: Array.from(worldBlocks.values()),
    users: Array.from(connectedUsers.values()),
    presets: getPresetList()
  });

  // Notificar a los demás usuarios sobre el nuevo cliente
  socket.broadcast.emit('user-joined', user);
  io.emit('users-update', Array.from(connectedUsers.values()));

  // Evento: Colocar cubo
  socket.on('place-block', (block) => {
    if (!block || typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.z !== 'number') return;
    const key = `${Math.round(block.x)},${Math.round(block.y)},${Math.round(block.z)}`;
    const blockData = {
      x: Math.round(block.x),
      y: Math.round(block.y),
      z: Math.round(block.z),
      color: block.color || '#2ecc71'
    };
    worldBlocks.set(key, blockData);

    // Transmitir a todos los demás clientes
    socket.broadcast.emit('block-placed', {
      block: blockData,
      userId: socket.id,
      userName: user.name
    });
  });

  // Evento: Borrar cubo
  socket.on('remove-block', (pos) => {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') return;
    const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
    if (worldBlocks.has(key)) {
      worldBlocks.delete(key);
      socket.broadcast.emit('block-removed', {
        x: Math.round(pos.x),
        y: Math.round(pos.y),
        z: Math.round(pos.z),
        userId: socket.id,
        userName: user.name
      });
    }
  });

  // Evento: Limpiar mundo completo
  socket.on('clear-world', () => {
    worldBlocks.clear();
    io.emit('world-cleared', { userId: socket.id, userName: user.name });
  });

  // Evento: Cargar preset en el mundo compartido
  socket.on('load-preset', (presetData) => {
    if (!presetData || !Array.isArray(presetData.blocks)) return;

    worldBlocks.clear();
    for (const b of presetData.blocks) {
      const key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.z)}`;
      worldBlocks.set(key, {
        x: Math.round(b.x),
        y: Math.round(b.y),
        z: Math.round(b.z),
        color: b.color || '#2ecc71'
      });
    }

    io.emit('world-synced', {
      blocks: Array.from(worldBlocks.values()),
      loadedBy: user.name,
      presetName: presetData.name
    });
  });

  // Evento: Mover cursor (para mostrar punteros multijugador)
  socket.on('cursor-move', (pos) => {
    socket.broadcast.emit('player-cursor', {
      userId: socket.id,
      userName: user.name,
      color: user.color,
      position: pos
    });
  });

  // Evento: Cambiar nombre del jugador
  socket.on('change-name', (newName) => {
    if (typeof newName === 'string' && newName.trim().length > 0) {
      user.name = newName.trim().slice(0, 20);
      connectedUsers.set(socket.id, user);
      io.emit('users-update', Array.from(connectedUsers.values()));
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    console.log(`[Desconexión] Usuario desconectado: ${user.name} (${socket.id}). Total: ${connectedUsers.size}`);
    socket.broadcast.emit('player-cursor-remove', { userId: socket.id });
    socket.broadcast.emit('user-left', user);
    io.emit('users-update', Array.from(connectedUsers.values()));
  });
});

server.listen(PORT, () => {
  console.log('========================================================');
  console.log(`   Minecraft 3D Voxel Editor - Servidor Iniciado`);
  console.log(`   Puerto de la aplicacion: ${PORT}`);
  console.log(`   Servidor local: http://localhost:${PORT}`);
  console.log(`   Multijugador activo mediante WebSockets`);
  console.log('========================================================');
});

