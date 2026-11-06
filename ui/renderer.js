// RVConnect Viewer Renderer Logic

// -------------------------------------------------------------
// Storage & State Keys (with backward compatibility)
// -------------------------------------------------------------
const STORAGE_DEVICES = 'rvconnect_saved_devices';
const STORAGE_SETTINGS = 'rvconnect_settings';
const STORAGE_PASSWORDS = 'rvconnect_saved_passwords';

// Default Settings
const defaultSettings = {
  scaling: 'fit',            // 'fit', '100%', 'stretch'
  quality: 'auto',           // 'auto', 'high', 'medium', 'low'
  refreshRate: 60,           // 60, 120, 30, 15 Hz
  resolution: 'auto',        // 'auto', '480x320', '800x600', '1024x768', '1280x720', '1920x1080'
  virtualResolution: '1280x720', // Default virtual desktop geometry (:1)
  cursorMode: 'local',       // 'local' (standard mouse arrow pointer), 'remote-only', 'dot'
  viewOnly: false,
  specialKeys: true,
  rememberPasswords: true,
  defaultPort: 5900,
  mdns: true
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS) || localStorage.getItem('realvnc_settings');
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch (e) {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
}

let appSettings = loadSettings();

// Password Vault
function getSavedPassword(host) {
  if (!host) return null;
  try {
    const raw = localStorage.getItem(STORAGE_PASSWORDS) || localStorage.getItem('realvnc_saved_passwords');
    const map = raw ? JSON.parse(raw) : {};
    const clean = host.split(':')[0].trim();
    if (map[clean]) return map[clean];
    if (map[host]) return map[host];
    return null;
  } catch (e) {
    return null;
  }
}

function storeSavedPassword(host, username, password) {
  if (!host) return;
  try {
    const raw = localStorage.getItem(STORAGE_PASSWORDS) || localStorage.getItem('realvnc_saved_passwords');
    const map = raw ? JSON.parse(raw) : {};
    const clean = host.split(':')[0].trim();
    const entry = { username: username || '', password: password || '' };
    map[clean] = entry;
    map[host] = entry;
    localStorage.setItem(STORAGE_PASSWORDS, JSON.stringify(map));
  } catch (e) {}
}

function clearAllSavedPasswords() {
  localStorage.removeItem(STORAGE_PASSWORDS);
  localStorage.removeItem('realvnc_saved_passwords');
}

// Saved Devices List
function loadSavedDevices() {
  try {
    const raw = localStorage.getItem(STORAGE_DEVICES) || localStorage.getItem('realvnc_saved_devices');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

function saveSavedDevices(devices) {
  localStorage.setItem(STORAGE_DEVICES, JSON.stringify(devices));
}

let savedDevices = loadSavedDevices();

// -------------------------------------------------------------
// Window Titlebar & Controls
// -------------------------------------------------------------
document.getElementById('btn-minimize').addEventListener('click', () => window.api.windowControl('minimize'));
document.getElementById('btn-maximize').addEventListener('click', () => window.api.windowControl('maximize'));
document.getElementById('btn-close').addEventListener('click', () => window.api.windowControl('close'));

// -------------------------------------------------------------
// Sidebar Navigation & Views
// -------------------------------------------------------------
const navButtons = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const sidebar = document.getElementById('sidebar');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetView = btn.dataset.view;
    navButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    views.forEach(v => {
      if (v.id === `view-${targetView}`) {
        v.classList.add('active');
      } else {
        v.classList.remove('active');
      }
    });

    if (targetView === 'home' || targetView === 'devices') {
      renderDeviceLists();
    }
  });
});

btnToggleSidebar.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

// -------------------------------------------------------------
// User Display Name
// -------------------------------------------------------------
const defaultUser = 'User';
const userDisplay = document.getElementById('user-display-name');
if (userDisplay) userDisplay.textContent = defaultUser;

// -------------------------------------------------------------
// Connection Manager
// -------------------------------------------------------------
let currentConnectingHost = '';
let currentConnectingPort = 5900;
let lastEnteredUsername = 'pi';
let lastEnteredPassword = '';

function initiateConnection(addr) {
  if (!addr || !addr.trim()) return;
  const raw = addr.trim();

  let host = raw;
  let port = appSettings.defaultPort || 5900;
  if (raw.includes(':')) {
    const parts = raw.split(':');
    host = parts[0];
    port = parseInt(parts[1], 10) || port;
  }

  currentConnectingHost = host;
  currentConnectingPort = port;

  showNotification(`Connecting to ${host}:${port}...`);
  window.api.connectVnc(`${host}:${port}`);
}

window.initiateConnection = initiateConnection;

// -------------------------------------------------------------
// Search Bar (Real-Time Filter & Direct Connect)
// -------------------------------------------------------------
const searchInput = document.getElementById('search-address');
const btnSearchConnect = document.getElementById('btn-search-connect');
const directInput = document.getElementById('direct-address-input');
const btnDirectConnect = document.getElementById('btn-direct-connect');

function handleSearchAction() {
  const query = searchInput.value.trim();
  if (!query) return;

  // Check if query matches any saved device by name or host
  const match = savedDevices.find(d => 
    (d.name && d.name.toLowerCase() === query.toLowerCase()) ||
    (d.host && d.host.toLowerCase() === query.toLowerCase())
  );
  if (match) {
    initiateConnection(`${match.host}:${match.port || 5900}`);
    return;
  }

  // Direct connect to entered query
  initiateConnection(query);
}

btnSearchConnect.addEventListener('click', handleSearchAction);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSearchAction();
});

// Real-time filter across saved devices as user types
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();

  // If user is searching from Settings, jump to Devices view to show live matches
  const activeView = document.querySelector('.view.active');
  if (activeView && activeView.id === 'view-settings' && q.length > 0) {
    navButtons.forEach(b => b.classList.remove('active'));
    const navDev = document.getElementById('nav-devices');
    if (navDev) navDev.classList.add('active');
    views.forEach(v => v.classList.remove('active'));
    const viewDev = document.getElementById('view-devices');
    if (viewDev) viewDev.classList.add('active');
  }

  renderDeviceLists(q);
});

btnDirectConnect.addEventListener('click', () => initiateConnection(directInput.value));
directInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') initiateConnection(directInput.value);
});

// -------------------------------------------------------------
// Saved Devices & Recents Rendering
// -------------------------------------------------------------
function timeAgo(ts) {
  if (!ts) return 'Never';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderDeviceLists(filterQuery = '') {
  const homeGrid = document.getElementById('home-recents-grid');
  const recentCountHint = document.getElementById('recent-count-hint');
  const savedGrid = document.getElementById('saved-devices-grid');
  const savedCount = document.getElementById('saved-devices-count');

  let list = savedDevices;
  if (filterQuery) {
    list = savedDevices.filter(d => 
      (d.name && d.name.toLowerCase().includes(filterQuery)) ||
      (d.host && d.host.toLowerCase().includes(filterQuery))
    );
  }

  if (recentCountHint) recentCountHint.textContent = `${list.length} saved`;
  if (savedCount) savedCount.textContent = `${list.length} devices`;

  // Render Home Recents
  if (homeGrid) {
    if (list.length === 0) {
      homeGrid.innerHTML = `
        <div style="color: var(--text-muted); font-size: 13px; grid-column: 1 / -1; padding: 12px 0;">
          ${filterQuery ? 'No devices match your search.' : 'No saved connections. Connect above or click "+ Add a device".'}
        </div>`;
    } else {
      homeGrid.innerHTML = list.map(dev => {
        const savedPass = getSavedPassword(dev.host);
        const hasPass = !!(savedPass && savedPass.password);
        return `
          <div class="recent-card">
            <div class="recent-card-header">
              <div class="recent-card-left">
                <div class="recent-avatar">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8BA8FF" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line>
                    <line x1="12" y1="17" x2="12" y2="21"></line>
                  </svg>
                </div>
                <div class="recent-meta">
                  <div class="recent-title">${escapeHtml(dev.name || dev.host)}</div>
                  <div class="recent-addr">${escapeHtml(dev.host)}:${dev.port || 5900}</div>
                  <div class="recent-time" style="display:flex; align-items:center; gap:6px;">
                    <span>${timeAgo(dev.lastConnected)}</span>
                    ${hasPass ? '<span style="color:var(--success-green); font-size:10.5px;">● Auto-Connect</span>' : ''}
                  </div>
                </div>
              </div>
              <button class="btn-icon danger" title="Forget device" onclick="deleteSavedDevice('${dev.id}')">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div class="recent-actions-row">
              <button class="btn-vnc-action btn-vnc-create" onclick="createVirtualDesktop('${dev.id}')" title="Start a fresh Virtual Desktop on :1 via SSH">⚡ Create :1</button>
              <button class="btn-vnc-action btn-vnc-connect" onclick="connectVirtualDesktop('${dev.id}')" title="Connect to existing Virtual Desktop on :1">🔌 Connect :1</button>
              <button class="btn-vnc-action btn-vnc-kill" onclick="killVirtualDesktopAction('${dev.id}')" title="Close & Kill Virtual Desktop on :1 via SSH">🛑 Close :1</button>
              <button class="btn-vnc-action btn-vnc-physical" onclick="connectToSavedDevice('${dev.id}')" title="Connect to Physical Console Screen (:0)">💻 Console :0</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Render Devices View Grid
  if (savedGrid) {
    if (list.length === 0) {
      savedGrid.innerHTML = `
        <div style="color: var(--text-muted); font-size: 13px; grid-column: 1 / -1; padding: 16px 0;">
          ${filterQuery ? 'No devices match your search.' : 'No devices added yet. Click "+ Add Device" above.'}
        </div>`;
    } else {
      savedGrid.innerHTML = list.map(dev => {
        const savedPass = getSavedPassword(dev.host);
        const hasPass = !!(savedPass && savedPass.password);
        return `
          <div class="device-card">
            <div class="device-card-header">
              <div class="device-card-info-wrap">
                <div class="device-avatar">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8BA8FF" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line>
                    <line x1="12" y1="17" x2="12" y2="21"></line>
                  </svg>
                </div>
                <div>
                  <div class="device-info-name">${escapeHtml(dev.name || dev.host)}</div>
                  <div class="device-info-ip">${escapeHtml(dev.host)}:${dev.port || 5900}</div>
                </div>
              </div>
              <button class="btn-icon danger" title="Remove device" onclick="deleteSavedDevice('${dev.id}')">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--text-muted); background: rgba(255,255,255,0.02); padding: 6px 10px; border-radius: 6px;">
              <span>User: <strong style="color: var(--text-secondary);">${escapeHtml(dev.username || 'pi')}</strong></span>
              <span>Password: <strong style="color: ${hasPass ? 'var(--success-green)' : 'var(--text-muted)'};">${hasPass ? 'Saved (Auto-Connect)' : 'Prompt'}</strong></span>
            </div>

            <div class="device-card-actions" style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-top:8px;">
              <button class="btn-vnc-action btn-vnc-create" onclick="createVirtualDesktop('${dev.id}')" title="Start a fresh Virtual Desktop on :1 via SSH">⚡ Create :1</button>
              <button class="btn-vnc-action btn-vnc-connect" onclick="connectVirtualDesktop('${dev.id}')" title="Connect to existing Virtual Desktop on :1">🔌 Connect :1</button>
              <button class="btn-vnc-action btn-vnc-kill" onclick="killVirtualDesktopAction('${dev.id}')" title="Stop & Kill Virtual Desktop on :1 via SSH">🛑 Close :1</button>
              <button class="btn-vnc-action btn-vnc-physical" onclick="connectToSavedDevice('${dev.id}')" title="Connect to Physical Console Screen (:0)">💻 Console :0</button>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:6px;">
              <button class="btn-icon" style="font-size:11px; color:var(--text-muted); cursor:pointer; padding:2px 6px;" onclick="editSavedDevice('${dev.id}')">⚙️ Edit Settings</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

window.connectToSavedDevice = function(id) {
  const dev = savedDevices.find(d => d.id === id);
  if (dev) {
    directInput.value = `${dev.host}:${dev.port || 5900}`;
    initiateConnection(`${dev.host}:${dev.port || 5900}`);
  }
};

window.createVirtualDesktop = async function(id) {
  const dev = savedDevices.find(d => d.id === id);
  if (!dev || !dev.host) {
    showNotification('Device not found. Please add device first.');
    return;
  }
  const host = dev.host;
  const savedCred = getSavedPassword(host) || {};
  const username = dev.username || savedCred.username || 'pi';
  const password = savedCred.password || '';

  if (!password) {
    showNotification(`Password required to SSH into ${host}. Please edit device to set password.`);
    openAddDeviceModal(id);
    return;
  }

  const targetRes = appSettings.virtualResolution || '1280x720';
  showNotification(`🚀 SSH connecting to ${host} to start Virtual Desktop (:1) at ${targetRes}...`);

  try {
    const res = await window.api.startVirtualDesktop({
      host,
      port: 22,
      username,
      password,
      display: 1,
      geometry: targetRes
    });

    // Wait until port 5901 responds (poll up to 8s)
    let isReady = false;
    for (let i = 1; i <= 16; i++) {
      await new Promise(r => setTimeout(r, 400));
      isReady = await window.api.probeDevice(host, 5901);
      if (isReady) break;
      if (i % 4 === 0) {
        showNotification(`⏳ Waiting for Virtual Desktop :1 on ${host}... (${Math.round(i * 0.4)}s)`);
      }
    }

    showNotification(`⚡ Virtual Desktop :1 (${targetRes}) active! Connecting to ${host}:5901...`);
    directInput.value = `${host}:5901`;
    initiateConnection(`${host}:5901`);
  } catch (err) {
    console.error('Create virtual desktop error:', err);
    showNotification(`Virtual Desktop failed: ${err.message || err}`);
  }
};

window.connectVirtualDesktop = async function(id) {
  const dev = savedDevices.find(d => d.id === id);
  if (!dev || !dev.host) {
    showNotification('Device not found.');
    return;
  }
  const host = dev.host;
  const savedCred = getSavedPassword(host) || {};
  const username = dev.username || savedCred.username || 'pi';
  const password = savedCred.password || '';

  showNotification(`🔍 Verifying Virtual Desktop on ${host}:5901...`);
  const isOnline = await window.api.probeDevice(host, 5901);
  if (!isOnline) {
    showNotification(`⚡ Virtual Desktop :1 is offline. Auto-starting via SSH on ${host}...`);
    await window.createVirtualDesktop(id);
    return;
  }

  // Ensure remote X11 root cursor is left_ptr arrow instead of cross
  if (password) {
    window.api.fixCursor({
      host,
      port: 22,
      username,
      password,
      display: 1
    }).catch(() => {});
  }

  showNotification(`🔌 Connecting to Virtual Desktop on ${host}:5901...`);
  directInput.value = `${host}:5901`;
  initiateConnection(`${host}:5901`);
};

window.killVirtualDesktopAction = async function(id) {
  const dev = savedDevices.find(d => d.id === id);
  if (!dev || !dev.host) return;
  const host = dev.host;
  const savedCred = getSavedPassword(host) || {};
  const username = dev.username || savedCred.username || 'pi';
  const password = savedCred.password || '';

  if (!password) {
    showNotification(`Password required to connect via SSH to ${host}.`);
    return;
  }

  showNotification(`🛑 SSH connecting to ${host} to close & terminate Virtual Desktop (:1)...`);

  try {
    await window.api.killVirtualDesktop({
      host,
      port: 22,
      username,
      password,
      display: 1
    });

    // If currently connected to port 5901, disconnect viewer
    if (currentConnectingPort === 5901 || (currentConnectingHost && currentConnectingHost.includes(':5901'))) {
      window.api.disconnectVnc();
    }

    showNotification(`🛑 Virtual Desktop :1 closed & terminated on ${host}`);
  } catch (err) {
    console.error('Kill virtual desktop error:', err);
    showNotification(`Failed to close Virtual Desktop: ${err.message}`);
  }
};

window.deleteSavedDevice = function(id) {
  const dev = savedDevices.find(d => d.id === id);
  if (dev) {
    // Remove stored password too
    try {
      const raw = localStorage.getItem(STORAGE_PASSWORDS);
      const map = raw ? JSON.parse(raw) : {};
      delete map[dev.host];
      delete map[dev.host.split(':')[0]];
      localStorage.setItem(STORAGE_PASSWORDS, JSON.stringify(map));
    } catch (e) {}
  }
  savedDevices = savedDevices.filter(d => d.id !== id);
  saveSavedDevices(savedDevices);
  renderDeviceLists();
  showNotification('Device removed from saved list');
};

// -------------------------------------------------------------
// Add / Edit Device Modal
// -------------------------------------------------------------
const deviceModal = document.getElementById('device-modal');
const deviceForm = document.getElementById('device-form');
const devName = document.getElementById('dev-name');
const devHost = document.getElementById('dev-host');
const devPort = document.getElementById('dev-port');
const devUsername = document.getElementById('dev-username');
const devPassword = document.getElementById('dev-password');
const btnDeviceCancel = document.getElementById('btn-device-cancel');
const deviceModalTitle = document.getElementById('device-modal-title');

let editingDeviceId = null;

function openAddDeviceModal(editId = null) {
  editingDeviceId = editId;
  if (editId) {
    const dev = savedDevices.find(d => d.id === editId);
    if (dev) {
      deviceModalTitle.textContent = 'Edit Saved Device';
      devName.value = dev.name;
      devHost.value = dev.host;
      devPort.value = dev.port || 5900;
      devUsername.value = dev.username || 'pi';
      const savedPass = getSavedPassword(dev.host);
      devPassword.value = savedPass ? savedPass.password : '';
    }
  } else {
    deviceModalTitle.textContent = 'Add Saved Device';
    devName.value = '';
    devHost.value = '';
    devPort.value = 5900;
    devUsername.value = 'pi';
    devPassword.value = '';
  }
  deviceModal.classList.add('active');
}

window.editSavedDevice = function(id) {
  openAddDeviceModal(id);
};

document.getElementById('btn-add-device').addEventListener('click', () => openAddDeviceModal());
const btnDevAdd = document.getElementById('btn-devices-add');
if (btnDevAdd) btnDevAdd.addEventListener('click', () => openAddDeviceModal());

btnDeviceCancel.addEventListener('click', () => {
  deviceModal.classList.remove('active');
});

deviceForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = devName.value.trim();
  const host = devHost.value.trim();
  const port = parseInt(devPort.value, 10) || 5900;
  const username = devUsername.value.trim() || 'pi';
  const password = devPassword.value;

  const newDev = {
    id: host,
    name: name || host,
    host,
    port,
    username,
    lastConnected: Date.now()
  };

  const existingIdx = savedDevices.findIndex(d => d.id === (editingDeviceId || host));
  if (existingIdx >= 0) {
    savedDevices[existingIdx] = newDev;
  } else {
    savedDevices.unshift(newDev);
  }

  // Save password if provided
  if (password) {
    storeSavedPassword(host, username, password);
  }

  saveSavedDevices(savedDevices);
  deviceModal.classList.remove('active');
  renderDeviceLists();
  showNotification(`Device "${newDev.name}" saved with auto-connect password`);
});

// -------------------------------------------------------------
// Authentication Modal & 100% Automatic Connect
// -------------------------------------------------------------
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const authTargetHost = document.getElementById('auth-target-host');
const authRemember = document.getElementById('auth-remember');
const groupUsername = document.getElementById('group-username');
const btnTogglePass = document.getElementById('btn-toggle-pass');
const btnAuthCancel = document.getElementById('btn-auth-cancel');

btnTogglePass.addEventListener('click', () => {
  authPassword.type = (authPassword.type === 'password') ? 'text' : 'password';
});

btnAuthCancel.addEventListener('click', () => {
  authModal.classList.remove('active');
  window.api.cancelAuth();
});

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = authUsername.value.trim() || 'pi';
  const password = authPassword.value;
  lastEnteredUsername = username;
  lastEnteredPassword = password;

  // Store password permanently for 1-click auto-connect
  if (authRemember.checked) {
    storeSavedPassword(currentConnectingHost, username, password);
    storeSavedPassword(authTargetHost.textContent, username, password);
  }

  authModal.classList.remove('active');
  showNotification('Authenticating with server...');
  window.api.submitCredentials({ username, password });
});

// -------------------------------------------------------------
// Remote Desktop Canvas & Controls
// -------------------------------------------------------------
const remoteViewport = document.getElementById('remote-viewport');
const canvas = document.getElementById('vnc-canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const toolbarRemoteName = document.getElementById('toolbar-remote-name');
const toolbarRemoteRes = document.getElementById('toolbar-remote-res');
const btnToolCad = document.getElementById('btn-tool-cad');
const btnToolCursor = document.getElementById('btn-tool-cursor');
const labelToolCursor = document.getElementById('label-tool-cursor');
const btnToolScale = document.getElementById('btn-tool-scale');
const labelToolScale = document.getElementById('label-tool-scale');
const btnToolFps = document.getElementById('btn-tool-fps');
const labelToolFps = document.getElementById('label-tool-fps');
const btnToolVirtual = document.getElementById('btn-tool-virtual');
const btnToolFullscreen = document.getElementById('btn-tool-fullscreen');
const btnToolDisconnect = document.getElementById('btn-tool-disconnect');

let fbWidth = 0;
let fbHeight = 0;
let mouseMask = 0;

// Apply initial cursor mode to canvas & viewport
function applyCursorMode(mode) {
  const container = document.getElementById('canvas-container');
  const viewport = document.getElementById('remote-viewport');

  canvas.classList.remove('cursor-remote-only', 'cursor-dot', 'cursor-local');
  if (container) container.classList.remove('cursor-remote-only', 'cursor-dot', 'cursor-local');
  if (viewport) viewport.classList.remove('cursor-remote-only', 'cursor-dot', 'cursor-local');

  canvas.classList.add(`cursor-${mode}`);
  if (container) container.classList.add(`cursor-${mode}`);
  if (viewport) viewport.classList.add(`cursor-${mode}`);

  if (mode === 'remote-only') {
    canvas.style.cursor = 'none';
    if (container) container.style.cursor = 'none';
  } else if (mode === 'dot') {
    const dotSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Ccircle cx='6' cy='6' r='4' fill='white' stroke='%23000' stroke-width='1.5'/%3E%3C/svg%3E";
    canvas.style.cursor = `url("${dotSvg}") 6 6, default`;
    if (container) container.style.cursor = `url("${dotSvg}") 6 6, default`;
  } else {
    canvas.style.cursor = 'default';
    if (container) container.style.cursor = 'default';
  }

  if (labelToolCursor) {
    labelToolCursor.textContent = (mode === 'remote-only') ? 'Remote Cursor' : 'Mouse Arrow';
  }
}
applyCursorMode(appSettings.cursorMode);

// Cursor mode toggle button on toolbar
btnToolCursor.addEventListener('click', () => {
  appSettings.cursorMode = (appSettings.cursorMode === 'local') ? 'remote-only' : 'local';
  saveSettings(appSettings);
  applyCursorMode(appSettings.cursorMode);
  const cfgCur = document.getElementById('cfg-cursor');
  if (cfgCur) cfgCur.value = appSettings.cursorMode;
  showNotification(`Cursor mode: ${appSettings.cursorMode === 'local' ? 'Standard Mouse Arrow Pointer' : 'Remote Cursor Only'}`);
});

// -------------------------------------------------------------
// Movable / Draggable Floating Toolbar (Dock)
// -------------------------------------------------------------
const remoteToolbar = document.getElementById('remote-toolbar');
const toolbarDragHandle = document.getElementById('toolbar-drag-handle');

let isDraggingToolbar = false;
let dragStartX = 0;
let dragStartY = 0;
let toolbarStartLeft = 0;
let toolbarStartTop = 0;

function initToolbarDraggable() {
  if (!remoteToolbar || !toolbarDragHandle) return;

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.tool-btn') || e.target.closest('button')) return;

    isDraggingToolbar = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = remoteToolbar.getBoundingClientRect();
    const parentRect = remoteToolbar.offsetParent ? remoteToolbar.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    toolbarStartLeft = rect.left - parentRect.left;
    toolbarStartTop = rect.top - parentRect.top;

    remoteToolbar.style.transform = 'none';
    remoteToolbar.style.left = `${toolbarStartLeft}px`;
    remoteToolbar.style.top = `${toolbarStartTop}px`;
    remoteToolbar.classList.add('is-dragging');

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isDraggingToolbar) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const containerW = remoteToolbar.offsetParent ? remoteToolbar.offsetParent.clientWidth : window.innerWidth;
    const containerH = remoteToolbar.offsetParent ? remoteToolbar.offsetParent.clientHeight : window.innerHeight;
    const toolbarW = remoteToolbar.offsetWidth;
    const toolbarH = remoteToolbar.offsetHeight;
    const maxLeft = Math.max(0, containerW - toolbarW - 8);
    const maxTop = Math.max(0, containerH - toolbarH - 8);

    let newLeft = Math.max(8, Math.min(maxLeft, toolbarStartLeft + dx));
    let newTop = Math.max(8, Math.min(maxTop, toolbarStartTop + dy));

    remoteToolbar.style.left = `${newLeft}px`;
    remoteToolbar.style.top = `${newTop}px`;
  }

  function onMouseUp() {
    if (!isDraggingToolbar) return;
    isDraggingToolbar = false;
    remoteToolbar.classList.remove('is-dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  toolbarDragHandle.addEventListener('mousedown', onMouseDown);
  remoteToolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tool-btn') || e.target.closest('button')) return;
    onMouseDown(e);
  });
}
initToolbarDraggable();

btnToolCad.addEventListener('click', () => {
  window.api.sendCad();
  showNotification('Sent Ctrl+Alt+Del');
});

btnToolDisconnect.addEventListener('click', (e) => {
  e.stopPropagation();
  // Immediately switch UI back to Dashboard
  remoteViewport.classList.remove('active');
  document.body.classList.remove('fullscreen-mode');
  showNotification('Disconnected from remote session');
  window.api.disconnectVnc();
});

btnToolFullscreen.addEventListener('click', () => {
  window.api.windowControl('fullscreen');
});

if (window.api.onFullscreenChange) {
  window.api.onFullscreenChange((isFS) => {
    if (isFS) {
      document.body.classList.add('fullscreen-mode');
      btnToolFullscreen.classList.add('active');
      btnToolFullscreen.setAttribute('title', 'Exit Fullscreen (F11)');
      showNotification('Entered Fullscreen (Press F11 to exit)');
    } else {
      document.body.classList.remove('fullscreen-mode');
      btnToolFullscreen.classList.remove('active');
      btnToolFullscreen.setAttribute('title', 'Enter Fullscreen (F11)');
      showNotification('Exited Fullscreen');
    }
    setTimeout(updateCanvasScale, 50);
  });
}

// Scale toggle: Fit, Stretch, 200%, 300%, 100%
const scaleModes = ['fit', 'stretch', '200%', '300%', '100%'];
btnToolScale.addEventListener('click', () => {
  const currentIdx = scaleModes.indexOf(appSettings.scaling);
  const nextMode = scaleModes[(currentIdx + 1) % scaleModes.length];
  appSettings.scaling = nextMode;
  saveSettings(appSettings);
  updateCanvasScale();
  const cfgSc = document.getElementById('cfg-scaling');
  if (cfgSc) cfgSc.value = appSettings.scaling;
  if (labelToolScale) {
    labelToolScale.textContent = appSettings.scaling.toUpperCase();
  }
  showNotification(`Display scaling: ${appSettings.scaling.toUpperCase()}`);
});

// Refresh rate toggle on toolbar
if (btnToolFps) {
  if (labelToolFps) labelToolFps.textContent = `${appSettings.refreshRate || 60} Hz`;
  btnToolFps.addEventListener('click', () => {
    let current = appSettings.refreshRate || 60;
    if (current === 60) current = 120;
    else if (current === 120) current = 30;
    else if (current === 30) current = 15;
    else current = 60;

    appSettings.refreshRate = current;
    saveSettings(appSettings);
    if (labelToolFps) labelToolFps.textContent = `${current} Hz`;
    const cfgFps = document.getElementById('cfg-refresh-rate');
    if (cfgFps) cfgFps.value = current;
    window.api.setRefreshRate(current);
    showNotification(`Target refresh rate: ${current} Hz (${current === 60 ? 'Smooth 60 FPS' : current === 120 ? 'Ultra High 120 FPS' : current + ' FPS'})`);
  });
}

if (btnToolVirtual) {
  btnToolVirtual.addEventListener('click', async () => {
    if (!currentConnectingHost) return;
    const rawHost = currentConnectingHost;
    const host = rawHost.includes(':') ? rawHost.split(':')[0] : rawHost;
    const savedCred = getSavedPassword(host) || {};
    const username = savedCred.username || 'pi';
    const password = savedCred.password || '';
    if (!password) {
      showNotification(`Password required to SSH into ${host}. Please save device credentials first.`);
      return;
    }
    const targetRes = appSettings.virtualResolution || '1280x720';
    showNotification(`⚡ Starting Virtual Desktop (:1) at ${targetRes} on ${host} via SSH...`);
    try {
      await window.api.startVirtualDesktop({
        host,
        port: 22,
        username,
        password,
        display: 1,
        geometry: targetRes
      });
      showNotification(`⚡ Virtual Desktop :1 (${targetRes}) ready! Connecting...`);
      setTimeout(() => {
        initiateConnection(`${host}:5901`);
      }, 400);
    } catch (err) {
      showNotification(`Virtual Desktop error: ${err.message || err}`);
    }
  });
}

function updateCanvasScale() {
  if (!fbWidth || !fbHeight) return;
  const container = document.getElementById('canvas-container');
  const isFS = document.body.classList.contains('fullscreen-mode');
  const availW = container ? container.clientWidth : window.innerWidth;
  const availH = container ? container.clientHeight : (window.innerHeight - (isFS ? 0 : 40));

  if (appSettings.scaling === '100%') {
    canvas.style.width = `${fbWidth}px`;
    canvas.style.height = `${fbHeight}px`;
  } else if (appSettings.scaling === '200%') {
    canvas.style.width = `${fbWidth * 2}px`;
    canvas.style.height = `${fbHeight * 2}px`;
  } else if (appSettings.scaling === '300%') {
    canvas.style.width = `${fbWidth * 3}px`;
    canvas.style.height = `${fbHeight * 3}px`;
  } else if (appSettings.scaling === 'stretch') {
    canvas.style.width = `${availW}px`;
    canvas.style.height = `${availH}px`;
  } else {
    // Proportional fit
    const scale = Math.min(availW / fbWidth, availH / fbHeight);
    const targetScale = (scale > 0 && isFinite(scale)) ? scale : 1;
    canvas.style.width = `${Math.floor(fbWidth * targetScale)}px`;
    canvas.style.height = `${Math.floor(fbHeight * targetScale)}px`;
  }
}

window.addEventListener('resize', updateCanvasScale);

// Canvas Input Events with High-Performance RAF Throttling
function getCanvasCoordinates(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = (rect.width > 0 && fbWidth > 0) ? (fbWidth / rect.width) : 1;
  const scaleY = (rect.height > 0 && fbHeight > 0) ? (fbHeight / rect.height) : 1;
  let rx = Math.floor((e.clientX - rect.left) * scaleX);
  let ry = Math.floor((e.clientY - rect.top) * scaleY);
  if (rx < 0) rx = 0; if (rx >= fbWidth) rx = fbWidth - 1;
  if (ry < 0) ry = 0; if (ry >= fbHeight) ry = fbHeight - 1;
  return { rx, ry };
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

let pendingPointer = null;
let pointerRafId = null;

function flushPointer() {
  if (pendingPointer && !appSettings.viewOnly) {
    window.api.sendPointer(pendingPointer.rx, pendingPointer.ry, pendingPointer.mask);
    pendingPointer = null;
  }
  pointerRafId = null;
}

canvas.addEventListener('mousemove', (e) => {
  if (appSettings.viewOnly) return;
  const { rx, ry } = getCanvasCoordinates(e);
  pendingPointer = { rx, ry, mask: mouseMask };
  if (!pointerRafId) {
    pointerRafId = requestAnimationFrame(flushPointer);
  }
});

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  canvas.focus();
  if (appSettings.viewOnly) return;
  if (e.button === 0) mouseMask |= 1;
  else if (e.button === 1) mouseMask |= 2;
  else if (e.button === 2) mouseMask |= 4;
  const { rx, ry } = getCanvasCoordinates(e);
  if (pointerRafId) {
    cancelAnimationFrame(pointerRafId);
    pointerRafId = null;
  }
  pendingPointer = null;
  window.api.sendPointer(rx, ry, mouseMask);
});

canvas.addEventListener('mouseup', (e) => {
  e.preventDefault();
  if (appSettings.viewOnly) return;
  if (e.button === 0) mouseMask &= ~1;
  else if (e.button === 1) mouseMask &= ~2;
  else if (e.button === 2) mouseMask &= ~4;
  const { rx, ry } = getCanvasCoordinates(e);
  if (pointerRafId) {
    cancelAnimationFrame(pointerRafId);
    pointerRafId = null;
  }
  pendingPointer = null;
  window.api.sendPointer(rx, ry, mouseMask);
});

// Ensure global mouse release even if cursor exits canvas during a click or drag
window.addEventListener('mouseup', (e) => {
  if (remoteViewport && remoteViewport.classList.contains('active') && mouseMask !== 0) {
    mouseMask = 0;
    const { rx, ry } = getCanvasCoordinates(e);
    window.api.sendPointer(rx, ry, 0);
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (appSettings.viewOnly) return;
  const { rx, ry } = getCanvasCoordinates(e);
  const wheelMask = (e.deltaY < 0) ? 8 : 16;
  if (pointerRafId) {
    cancelAnimationFrame(pointerRafId);
    pointerRafId = null;
  }
  pendingPointer = null;
  window.api.sendPointer(rx, ry, mouseMask | wheelMask);
  window.api.sendPointer(rx, ry, mouseMask);
}, { passive: false });

// Keyboard Key to X11 Keysym
function getKeysym(e) {
  switch (e.key) {
    case 'Backspace': return 0xFF08;
    case 'Tab': return 0xFF09;
    case 'Enter': return 0xFF0D;
    case 'Escape': return 0xFF1B;
    case 'Insert': return 0xFF63;
    case 'Delete': return 0xFFFF;
    case 'Home': return 0xFF50;
    case 'End': return 0xFF57;
    case 'PageUp': return 0xFF55;
    case 'PageDown': return 0xFF56;
    case 'ArrowLeft': return 0xFF51;
    case 'ArrowUp': return 0xFF52;
    case 'ArrowRight': return 0xFF53;
    case 'ArrowDown': return 0xFF54;
    case 'F1': return 0xFFBE;
    case 'F2': return 0xFFBF;
    case 'F3': return 0xFFC0;
    case 'F4': return 0xFFC1;
    case 'F5': return 0xFFC2;
    case 'F6': return 0xFFC3;
    case 'F7': return 0xFFC4;
    case 'F8': return 0xFFC5;
    case 'F9': return 0xFFC6;
    case 'F10': return 0xFFC7;
    case 'F11': return 0xFFC8;
    case 'F12': return 0xFFC9;
    case 'Shift': return e.location === 2 ? 0xFFE2 : 0xFFE1;
    case 'Control': return e.location === 2 ? 0xFFE4 : 0xFFE3;
    case 'Alt': return e.location === 2 ? 0xFFEA : 0xFFE9;
    case 'Meta': return 0xFFEB;
    default:
      if (e.key.length === 1) return e.key.charCodeAt(0);
      return 0;
  }
}

window.addEventListener('keydown', (e) => {
  if (remoteViewport.classList.contains('active')) {
    if (e.key === 'F11') {
      e.preventDefault();
      window.api.windowControl('fullscreen');
      return;
    }
    if (appSettings.viewOnly) return;
    const keysym = getKeysym(e);
    if (keysym) {
      e.preventDefault();
      window.api.sendKey(keysym, true);
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (remoteViewport.classList.contains('active')) {
    if (appSettings.viewOnly) return;
    const keysym = getKeysym(e);
    if (keysym) {
      e.preventDefault();
      window.api.sendKey(keysym, false);
    }
  }
});

// -------------------------------------------------------------
// RFB IPC Event Handlers
// -------------------------------------------------------------
window.api.onConnected(({ width, height, name }) => {
  fbWidth = width;
  fbHeight = height;
  canvas.width = width;
  canvas.height = height;

  const displayName = name || currentConnectingHost || 'RVConnect Desktop';
  toolbarRemoteName.textContent = displayName;
  toolbarRemoteRes.textContent = `${width}x${height}`;
  if (labelToolFps) labelToolFps.textContent = `${appSettings.refreshRate || 60} Hz`;
  window.api.setRefreshRate(appSettings.refreshRate || 60);
  remoteViewport.classList.add('active');
  updateCanvasScale();
  setTimeout(updateCanvasScale, 100);

  // If connected to Virtual Desktop (:1 / 5901), ensure root cursor is left_ptr arrow
  if (currentConnectingPort === 5901 || (currentConnectingHost && currentConnectingHost.includes(':5901'))) {
    const rawHost = currentConnectingHost ? currentConnectingHost.split(':')[0] : '';
    if (rawHost) {
      const savedCred = getSavedPassword(rawHost) || {};
      if (savedCred.password) {
        window.api.fixCursor({
          host: rawHost,
          port: 22,
          username: savedCred.username || 'pi',
          password: savedCred.password,
          display: 1
        }).catch(() => {});
      }
    }
  }

  // Update or record in saved devices
  const existing = savedDevices.find(d => d.host === currentConnectingHost);
  if (existing) {
    if (name && (!existing.name || existing.name === existing.host)) existing.name = name;
    existing.lastConnected = Date.now();
  } else if (currentConnectingHost) {
    savedDevices.unshift({
      id: currentConnectingHost,
      name: name || currentConnectingHost,
      host: currentConnectingHost,
      port: currentConnectingPort || 5900,
      username: lastEnteredUsername || 'pi',
      lastConnected: Date.now()
    });
  }

  // Ensure remembered password is saved
  if (lastEnteredPassword) {
    storeSavedPassword(currentConnectingHost, lastEnteredUsername, lastEnteredPassword);
  }

  saveSavedDevices(savedDevices);
  renderDeviceLists();

  showNotification(`Connected to ${displayName} (${width}x${height})`);
});

window.api.onDisconnected(() => {
  remoteViewport.classList.remove('active');
  showNotification('Disconnected from remote server');
});

window.api.onError((err) => {
  authModal.classList.remove('active');
  remoteViewport.classList.remove('active');
  showNotification(`Error: ${err}`);
});

// Authentication Required Handler with 100% Seamless Auto-Connect
window.api.onAuthRequired(({ authType, host }) => {
  authTargetHost.textContent = host;

  // Check vault for remembered password
  const savedCred = getSavedPassword(host) || getSavedPassword(currentConnectingHost);

  if (appSettings.rememberPasswords && savedCred && savedCred.password) {
    // 1-Click Auto-Connect: NO MODAL SHOWN!
    showNotification(`Authenticating automatically as ${savedCred.username || 'pi'}...`);
    window.api.submitCredentials({
      username: savedCred.username || 'pi',
      password: savedCred.password
    });
    return;
  }

  // Fallback: If no password saved yet, prompt user once
  if (authType === 'vnc') {
    groupUsername.style.display = 'none';
  } else {
    groupUsername.style.display = 'block';
    authUsername.value = (savedCred && savedCred.username) ? savedCred.username : (lastEnteredUsername || 'pi');
  }

  authPassword.value = '';
  authRemember.checked = true;
  authModal.classList.add('active');

  setTimeout(() => {
    if (groupUsername.style.display === 'block' && !authUsername.value) {
      authUsername.focus();
    } else {
      authPassword.focus();
    }
  }, 60);
});

window.api.onResize(({ width, height }) => {
  fbWidth = width;
  fbHeight = height;
  canvas.width = width;
  canvas.height = height;
  toolbarRemoteRes.textContent = `${width}x${height}`;
  updateCanvasScale();
});

// Render rectangular updates - Zero-Copy Blit directly to Canvas
window.api.onRect(({ x, y, width, height, data }) => {
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(data);
  ctx.putImageData(imgData, x, y);
});

// Solid fill
window.api.onFill(({ x, y, width, height, color }) => {
  ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  ctx.fillRect(x, y, width, height);
});

// CopyRect
window.api.onCopyRect(({ x, y, width, height, srcX, srcY }) => {
  ctx.drawImage(canvas, srcX, srcY, width, height, x, y, width, height);
});

// Clipboard Synchronization Handler
if (window.api.onClipboardSync) {
  window.api.onClipboardSync(({ direction, text }) => {
    const preview = text && text.length > 28 ? `${text.slice(0, 28)}...` : (text || '');
    if (direction === 'remote-to-local') {
      showNotification(`📋 Remote text copied to Windows clipboard ("${preview}")`);
    } else {
      showNotification(`📋 Windows clipboard synced to Raspberry Pi ("${preview}")`);
    }
  });
}

// -------------------------------------------------------------
// Discovered LAN Devices (mDNS)
// -------------------------------------------------------------
const discoveredGrid = document.getElementById('discovered-devices-grid');
const discoveredMap = new Map();

window.api.onDeviceDiscovered((dev) => {
  if (discoveredMap.has(dev.ip)) return;
  if (discoveredMap.size === 0 && discoveredGrid) {
    discoveredGrid.innerHTML = '';
  }
  discoveredMap.set(dev.ip, dev);

  if (discoveredGrid) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.innerHTML = `
      <div class="device-card-header">
        <div class="device-card-info-wrap">
          <div class="device-avatar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8BA8FF" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
          <div>
            <div class="device-info-name">${escapeHtml(dev.name)}</div>
            <div class="device-info-ip">${escapeHtml(dev.ip)}:${dev.port || 5900}</div>
          </div>
        </div>
      </div>
      <div class="device-status-badge">
        <span class="status-dot"></span>
        Broadcasting on LAN
      </div>
      <button class="btn btn-secondary" style="width: 100%;" onclick="initiateConnection('${dev.ip}:${dev.port || 5900}')">Connect</button>
    `;
    discoveredGrid.appendChild(card);
  }
});

const btnRefreshDev = document.getElementById('btn-refresh-devices');
async function executeLanScan() {
  if (discoveredGrid) {
    discoveredGrid.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; grid-column: 1 / -1; padding: 12px 0;">Scanning subnet for VNC / RFB servers...</div>';
  }
  discoveredMap.clear();
  showNotification('Scanning LAN for VNC / RFB Servers...');
  await window.api.rescanLan();
  if (discoveredMap.size === 0 && discoveredGrid) {
    discoveredGrid.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; grid-column: 1 / -1; padding: 12px 0;">No active VNC servers found on local subnet. Click "Scan Local Network" to search again.</div>';
    showNotification('LAN scan complete: No active VNC servers detected on local subnet.');
  } else {
    showNotification(`LAN scan complete: Found ${discoveredMap.size} device(s) broadcasting VNC.`);
  }
}

if (btnRefreshDev) {
  btnRefreshDev.addEventListener('click', executeLanScan);
}

// Auto-scan local subnet on startup
setTimeout(executeLanScan, 600);

// -------------------------------------------------------------
// Settings View Handlers
// -------------------------------------------------------------
const cfgScaling = document.getElementById('cfg-scaling');
const cfgQuality = document.getElementById('cfg-quality');
const cfgRefreshRate = document.getElementById('cfg-refresh-rate');
const cfgResolution = document.getElementById('cfg-resolution');
const cfgVirtualResolution = document.getElementById('cfg-virtual-resolution');
const cfgCursor = document.getElementById('cfg-cursor');
const cfgViewOnly = document.getElementById('cfg-view-only');
const cfgSpecialKeys = document.getElementById('cfg-special-keys');
const cfgRememberPass = document.getElementById('cfg-remember-passwords');
const cfgPort = document.getElementById('cfg-port');
const cfgMdns = document.getElementById('cfg-mdns');
const btnClearStorage = document.getElementById('btn-clear-storage');

if (cfgScaling) cfgScaling.value = appSettings.scaling;
if (cfgQuality) cfgQuality.value = appSettings.quality;
if (cfgRefreshRate) cfgRefreshRate.value = appSettings.refreshRate || 60;
if (cfgResolution) cfgResolution.value = appSettings.resolution || 'auto';
if (cfgVirtualResolution) cfgVirtualResolution.value = appSettings.virtualResolution || '1280x720';
if (cfgCursor) cfgCursor.value = appSettings.cursorMode;
if (cfgViewOnly) cfgViewOnly.checked = !!appSettings.viewOnly;
if (cfgSpecialKeys) cfgSpecialKeys.checked = appSettings.specialKeys;
if (cfgRememberPass) cfgRememberPass.checked = appSettings.rememberPasswords;
if (cfgPort) cfgPort.value = appSettings.defaultPort;
if (cfgMdns) cfgMdns.checked = appSettings.mdns;

if (cfgVirtualResolution) {
  cfgVirtualResolution.addEventListener('change', () => {
    appSettings.virtualResolution = cfgVirtualResolution.value;
    saveSettings(appSettings);
    showNotification(`Virtual desktop default resolution set to ${appSettings.virtualResolution}`);
  });
}

if (cfgRefreshRate) {
  cfgRefreshRate.addEventListener('change', () => {
    appSettings.refreshRate = parseInt(cfgRefreshRate.value, 10) || 60;
    saveSettings(appSettings);
    if (labelToolFps) labelToolFps.textContent = `${appSettings.refreshRate} Hz`;
    window.api.setRefreshRate(appSettings.refreshRate);
    showNotification(`Target refresh rate set to ${appSettings.refreshRate} Hz`);
  });
}

if (cfgResolution) {
  cfgResolution.addEventListener('change', () => {
    appSettings.resolution = cfgResolution.value;
    saveSettings(appSettings);
    showNotification(`Resolution preference set to ${appSettings.resolution}`);
  });
}

if (cfgViewOnly) {
  cfgViewOnly.addEventListener('change', () => {
    appSettings.viewOnly = cfgViewOnly.checked;
    saveSettings(appSettings);
    showNotification(appSettings.viewOnly ? 'View-Only Mode enabled (Inputs disabled)' : 'Interactive Mode enabled');
  });
}

if (cfgScaling) {
  cfgScaling.addEventListener('change', () => {
    appSettings.scaling = cfgScaling.value;
    saveSettings(appSettings);
    updateCanvasScale();
    showNotification(`Scaling set to ${appSettings.scaling}`);
  });
}

if (cfgQuality) {
  cfgQuality.addEventListener('change', () => {
    appSettings.quality = cfgQuality.value;
    saveSettings(appSettings);
    showNotification(`Quality preference set to ${appSettings.quality}`);
  });
}

if (cfgCursor) {
  cfgCursor.addEventListener('change', () => {
    appSettings.cursorMode = cfgCursor.value;
    saveSettings(appSettings);
    applyCursorMode(appSettings.cursorMode);
    showNotification(`Mouse cursor set to ${appSettings.cursorMode}`);
  });
}

if (cfgSpecialKeys) {
  cfgSpecialKeys.addEventListener('change', () => {
    appSettings.specialKeys = cfgSpecialKeys.checked;
    saveSettings(appSettings);
  });
}

if (cfgRememberPass) {
  cfgRememberPass.addEventListener('change', () => {
    appSettings.rememberPasswords = cfgRememberPass.checked;
    saveSettings(appSettings);
  });
}

if (cfgPort) {
  cfgPort.addEventListener('change', () => {
    appSettings.defaultPort = parseInt(cfgPort.value, 10) || 5900;
    saveSettings(appSettings);
  });
}

if (cfgMdns) {
  cfgMdns.addEventListener('change', () => {
    appSettings.mdns = cfgMdns.checked;
    saveSettings(appSettings);
  });
}

if (btnClearStorage) {
  btnClearStorage.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all remembered passwords?')) {
      clearAllSavedPasswords();
      renderDeviceLists();
      showNotification('All saved passwords cleared');
    }
  });
}

// -------------------------------------------------------------
// Notification Toast
// -------------------------------------------------------------
function showNotification(msg) {
  const banner = document.getElementById('notification-banner');
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.add('active');
  clearTimeout(banner._timeout);
  banner._timeout = setTimeout(() => {
    banner.classList.remove('active');
  }, 4000);
}

// -------------------------------------------------------------
// Initial Boot
// -------------------------------------------------------------
renderDeviceLists();
