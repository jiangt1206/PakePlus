// script.js (FIXED: updateStats function re-added)

// 全局变量
var devices = [];
var proxyConfig = { url: "", timeout: 10 };
var isEditMode = false;
var editingDeviceId = null;
var currentDetailDeviceId = null;
var deleteDeviceId = null;

// 轮询管理
var listPollingInterval = null;
var detailPollingInterval = null;
const LIST_POLLING_RATE = 15000; // 列表页轮询频率：15秒
const DETAIL_POLLING_RATE = 3000;  // 详情页轮询频率：3秒


// --- 1. 工具函数 ---
function sanitizeInput(input) {
  if (typeof input !== "string") return input;
  const entities = {
    "&": "&",
    "<": "<",
    ">": ">",
    '"': '"',
    "'": "'",
  };
  return input.replace(/[&<>"']/g, (char) => entities[char]);
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return "从未更新";
    const now = Date.now();
    const seconds = Math.floor((now - timestamp) / 1000);
    if (seconds < 10) return "刚刚更新";
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
}

function isValidIP(ip) {
  var ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipRegex.test(ip);
}

function isValidPort(port) {
  const portNum = Number.parseInt(port);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

// --- 2. 存储管理 ---
var Storage = {
  set: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify({ value }));
      return true;
    } catch (e) {
      console.error("存储失败:", e);
      showToast("存储空间不足", "error");
      return false;
    }
  },
  get: (key, defaultValue = null) => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item).value : defaultValue;
    } catch (e) {
      console.error("读取存储失败:", e);
      return defaultValue;
    }
  },
};

// --- 3. 数据加载和保存 ---
function loadAppData() {
  devices = Storage.get("smart_home_devices", []);
  proxyConfig = Storage.get("proxy_config", { url: "", timeout: 10 });
  devices = devices.filter(d => d && d.id && d.name);
  devices.forEach(d => {
    d.commands = d.commands || [];
    d.info = d.info || {};
    d.status = "offline"; // 每次加载都重置状态
  });
}

function saveDevices() {
  return Storage.set("smart_home_devices", devices);
}

function saveProxyConfig() {
  return Storage.set("proxy_config", proxyConfig);
}

// --- 4. 网络和请求 ---
var NetworkMonitor = {
  isOnline: navigator.onLine,
  init: function () {
    const update = (online) => {
      this.isOnline = online;
      document.getElementById("offlineIndicator").classList.toggle("show", !online);
      if (online) {
        showToast("网络连接已恢复", "success");
        startListPolling(); // 网络恢复时，启动列表轮询
      } else {
        showToast("网络连接已断开", "error");
        stopAllPolling();
      }
    };
    window.addEventListener("online", () => update(true));
    window.addEventListener("offline", () => update(false));
  },
};

function makeDeviceRequest(config) {
    if (!NetworkMonitor.isOnline) return Promise.reject(new Error("网络连接不可用"));
    if (!proxyConfig.url) return Promise.reject(new Error("代理服务器未配置"));
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), (config.timeout || proxyConfig.timeout) * 1000);

    return fetch(proxyConfig.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            esp_ip: config.esp_ip,
            esp_port: config.esp_port,
            path: config.path,
            method: config.method || "GET",
            timeout: config.timeout,
        }),
        signal: controller.signal,
    }).then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) {
            return response.text().then(text => { throw new Error(text || `HTTP Error ${response.status}`) });
        }
        return response.json();
    }).catch(error => {
        clearTimeout(timeoutId);
        if (error.name === "AbortError") throw new Error("请求超时");
        throw error;
    });
}

// --- 5. 核心状态管理和轮询 ---
function stopAllPolling() {
  if (listPollingInterval) clearInterval(listPollingInterval);
  if (detailPollingInterval) clearInterval(detailPollingInterval);
  listPollingInterval = null;
  detailPollingInterval = null;
  console.log("所有轮询已停止");
}

function startListPolling() {
  stopAllPolling();
  if (!proxyConfig.url || !NetworkMonitor.isOnline) return;
  
  const poll = () => {
    console.log("正在执行列表页轮询...");
    devices.forEach((device, i) => {
      getDeviceStatus(i, true).catch(error => {
        // console.warn(`设备 ${device.name} 状态检查失败:`, error.message);
      });
    });
  };
  
  poll();
  listPollingInterval = setInterval(poll, LIST_POLLING_RATE);
  console.log("列表页轮询已启动");
}

function startDetailPolling() {
  stopAllPolling();
  if (!proxyConfig.url || !NetworkMonitor.isOnline) return;

  const poll = () => {
    if (!currentDetailDeviceId) {
        stopAllPolling();
        return;
    }
    const deviceIndex = devices.findIndex(d => String(d.id) === String(currentDetailDeviceId));
    if (deviceIndex !== -1) {
        console.log(`正在执行详情页轮询: ${devices[deviceIndex].name}`);
        getDeviceStatus(deviceIndex, true, false);
    }
  };

  poll();
  detailPollingInterval = setInterval(poll, DETAIL_POLLING_RATE);
  console.log("详情页轮询已启动");
}

function getDeviceStatus(deviceIndex, shouldUpdateUI, showSuccessToast = false) {
  const device = devices[deviceIndex];
  if (!device) return Promise.reject(new Error("无效的设备索引"));

  return makeDeviceRequest({
    esp_ip: device.esp_ip,
    esp_port: device.esp_port,
    path: "/status",
    timeout: device.timeout,
  })
    .then(response => {
      device.status = "online";
      device.info = { ...device.info, ...response };
      device.lastUpdated = Date.now();
      if (showSuccessToast) showToast("设备状态已更新", "success");
    })
    .catch(error => {
      device.status = "offline";
      throw error;
    })
    .finally(() => {
      if (shouldUpdateUI) {
        saveDevices();
        updateStats(); // [依赖] updateStats 在这里被调用
        updateSingleDeviceInList(device);
        if (String(currentDetailDeviceId) === String(device.id)) {
          updateDetailView(device);
        }
      }
    });
}

// --- 6. UI 渲染和视图切换 ---
// [修复] 将 updateStats 函数定义移到此处
function updateStats() {
    const onlineCount = devices.filter((d) => d.status === "online").length;
    document.getElementById("totalDevices").textContent = devices.length;
    document.getElementById("onlineDevices").textContent = onlineCount;
}

function updateProxyStatus() {
  const indicator = document.getElementById("proxyIndicator");
  const statusText = document.getElementById("proxyStatusText");
  if (proxyConfig.url) {
    indicator.classList.add("online");
    statusText.textContent = "已连接";
  } else {
    indicator.classList.remove("online");
    statusText.textContent = "未配置";
  }
}

function showListView() {
    stopAllPolling();
    startListPolling();
    document.getElementById("detailView").classList.remove("show");
    document.getElementById("listView").classList.remove("hidden");
    document.getElementById("backBtn").classList.add("hidden");
    document.getElementById("appTitle").textContent = "智能家居";
    currentDetailDeviceId = null;
    renderDevicesList();
}

function showDetailView(deviceId) {
    const device = devices.find(d => String(d.id) === String(deviceId));
    if (!device) {
        showToast("设备不存在", "error");
        return;
    }
    currentDetailDeviceId = deviceId;
    updateDetailView(device);

    stopAllPolling();
    startDetailPolling();

    document.getElementById("listView").classList.add("hidden");
    document.getElementById("detailView").classList.add("show");
    document.getElementById("backBtn").classList.remove("hidden");
    document.getElementById("appTitle").textContent = sanitizeInput(device.name);
    
    document.getElementById("detailRefreshBtn").onclick = () => {
        const refreshBtn = document.getElementById("detailRefreshBtn");
        showLoading(refreshBtn, true);
        const deviceIndex = devices.findIndex(d => String(d.id) === String(currentDetailDeviceId));
        if (deviceIndex !== -1) {
            getDeviceStatus(deviceIndex, true, true)
                .catch(err => handleError(err, "手动刷新失败"))
                .finally(() => showLoading(refreshBtn, false));
        }
    };
    document.getElementById("detailEditBtn").onclick = () => openEditDeviceModal(device.id);
    document.getElementById("detailDeleteBtn").onclick = () => confirmDeleteDevice(device.id);
}

function renderDevicesList() {
    const container = document.getElementById("devicesContainer");
    const emptyState = document.getElementById("emptyState");
    const errorState = document.getElementById("errorState");
    errorState.style.display = 'none';

    if (devices.length === 0) {
        container.innerHTML = "";
        emptyState.style.display = "block";
    } else {
        container.innerHTML = devices.map(createDeviceListItem).join("");
        emptyState.style.display = "none";
    }
    updateStats(); // [依赖] updateStats 在这里被调用
}

function createDeviceListItem(device) {
    const statusClass = device.status === 'online' ? 'status-online' : 'status-offline';
    const safeState = device.info.current_state ? sanitizeInput(device.info.current_state) : '未知';
    return `
        <div class="device-list-item" data-device-id="${device.id}" onclick="showDetailView('${device.id}')">
            <div class="device-avatar">${getDeviceIcon(device.name)}</div>
            <div class="device-info">
                <div class="device-name">${sanitizeInput(device.name)}</div>
                <div class="device-details">${sanitizeInput(device.esp_ip)} • ${safeState}</div>
            </div>
            <span class="device-status-badge ${statusClass}">${device.status === 'online' ? '在线' : '离线'}</span>
        </div>`;
}

function updateSingleDeviceInList(device) {
    const element = document.querySelector(`.device-list-item[data-device-id='${device.id}']`);
    if (element) {
        element.outerHTML = createDeviceListItem(device);
    }
}

function updateDetailView(device) {
    if (!device) return;
    document.getElementById("detailAvatar").innerHTML = getDeviceIcon(device.name);
    document.getElementById("detailName").textContent = sanitizeInput(device.name);
    const statusEl = document.getElementById("detailStatus");
    statusEl.textContent = device.status === 'online' ? '在线' : '离线';
    statusEl.className = `device-detail-status ${device.status === 'online' ? 'status-online' : 'status-offline'}`;
    document.getElementById("lastUpdatedText").textContent = formatTimeAgo(device.lastUpdated);

    const deviceInfo = device.info || {};
    const badges = [
        { icon: "fas fa-microchip", label: sanitizeInput(deviceInfo.device || "未知型号") },
        { icon: "fas fa-network-wired", label: sanitizeInput(deviceInfo.ip_address || device.esp_ip) },
        { icon: "fas fa-code-branch", label: sanitizeInput(deviceInfo.firmware || "未知固件") },
        { icon: "fas fa-toggle-on", label: sanitizeInput(deviceInfo.current_state || "未知状态") },
    ];
    document.getElementById("deviceInfoBadges").innerHTML = badges.map(b => 
        `<div class="info-badge"><i class="${b.icon}"></i><span>${b.label}</span></div>`
    ).join('');

    const controlsContainer = document.getElementById("detailControls");
    const controlCommands = device.commands.filter(c => c.path !== '/status');
    if (controlCommands.length > 0) {
        controlsContainer.innerHTML = controlCommands.map(command => {
            const isDisabled = device.status === 'offline' || isControlDisabled(command, device);
            return `
                <button class="control-btn" ${isDisabled ? 'disabled' : ''} onclick="executeDeviceCommand(this, '${command.path}', '${sanitizeInput(command.name)}')">
                    <span class="control-content">
                        <div class="control-btn-icon">${getControlIcon(command.name)}</div>
                        <span class="control-btn-label">${sanitizeInput(command.name)}</span>
                    </span>
                    <span class="loading-spinner" style="display: none;"></span>
                </button>`;
        }).join('');
    } else {
        controlsContainer.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 2rem;"><i class="fas fa-cog" style="font-size: 2rem; margin-bottom: 1rem; opacity: 0.5;"></i><p>暂无可用控制命令</p></div>`;
    }
}


// --- 7. 命令执行 ---
function executeDeviceCommand(buttonElement, commandPath, commandName) {
    if (!currentDetailDeviceId) return;
    stopAllPolling();

    const content = buttonElement.querySelector('.control-content');
    const spinner = buttonElement.querySelector('.loading-spinner');
    if (buttonElement.classList.contains('loading')) return;

    buttonElement.classList.add('loading');
    content.style.display = 'none';
    spinner.style.display = 'inline-block';
    document.querySelectorAll('.control-btn').forEach(btn => btn.disabled = true);
    
    const device = devices.find(d => String(d.id) === String(currentDetailDeviceId));
    if (!device) {
        startDetailPolling();
        return;
    }

    makeDeviceRequest({
        esp_ip: device.esp_ip,
        esp_port: device.esp_port,
        path: commandPath,
        method: "GET",
        timeout: device.timeout,
    })
    .then(response => {
        console.log(`命令 "${commandName}" 成功, 返回:`, response);
        if (response && response.current_state) {
            device.info.current_state = response.current_state;
            device.status = "online";
            device.lastUpdated = Date.now();
            updateDetailView(device);
        }
    })
    .catch(error => handleError(error, `执行命令 ${commandName} 失败`))
    .finally(() => {
        setTimeout(startDetailPolling, 500);
    });
}

// --- 8. 模态框和事件监听 ---
function showLoading(element, show) {
    const icon = element.querySelector("i");
    if (show) {
        element.classList.add("loading");
        if (icon) icon.className = "loading-spinner";
    } else {
        element.classList.remove("loading");
        if (icon) icon.className = "fas fa-sync-alt";
    }
}

function handleError(error, context = "未知操作") {
  console.error(`${context}时发生错误:`, error);
  showToast(error.message || "发生未知错误", "error");
}

function showToast(message, type = "success") {
    const toastContainer = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 100);
    setTimeout(() => {
        toast.classList.remove("show");
        toast.addEventListener('transitionend', () => toast.remove());
    }, 3000);
}

function openAddDeviceModal(){isEditMode=!1,editingDeviceId=null,document.getElementById("deviceForm").reset(),document.getElementById("devicePort").value="80",document.getElementById("deviceTimeout").value="3",document.getElementById("modalTitle").textContent="添加新设备",document.getElementById("submitBtn").textContent="添加设备",resetCommandsList(),document.getElementById("deviceModal").classList.add("show")}function openEditDeviceModal(e){let t=devices.find(t=>String(t.id)===String(e));t&&(isEditMode=!0,editingDeviceId=e,document.getElementById("deviceName").value=t.name,document.getElementById("deviceIp").value=t.esp_ip,document.getElementById("devicePort").value=t.esp_port,document.getElementById("deviceTimeout").value=t.timeout,document.getElementById("modalTitle").textContent="编辑设备",document.getElementById("submitBtn").textContent="保存修改",fillCommandsList(t.commands||[]),document.getElementById("deviceModal").classList.add("show"))}function closeDeviceModal(){document.getElementById("deviceModal").classList.remove("show")}function openProxyConfigModal(){document.getElementById("proxyUrl").value=proxyConfig.url,document.querySelector('input[name="proxy_timeout"]').value=proxyConfig.timeout,document.getElementById("proxyConfigModal").classList.add("show")}function closeProxyConfigModal(){document.getElementById("proxyConfigModal").classList.remove("show")}function confirmDeleteDevice(e){let t=devices.find(t=>String(t.id)===String(e));t&&(deleteDeviceId=e,document.getElementById("confirmMessage").textContent=`确定要删除设备 "${sanitizeInput(t.name)}" 吗？此操作无法撤销。`,document.getElementById("confirmDialog").classList.add("show"),document.getElementById("confirmDeleteBtn").onclick=deleteDevice)}function closeConfirmDialog(){document.getElementById("confirmDialog").classList.remove("show"),deleteDeviceId=null}function deleteDevice(){if(!deleteDeviceId)return;const e=devices.find(t=>String(t.id)===String(deleteDeviceId))?.name;devices=devices.filter(t=>String(t.id)!==String(deleteDeviceId)),saveDevices()&&(closeConfirmDialog(),showListView(),renderDevicesList(),updateStats(),showToast(`设备 "${sanitizeInput(e)}" 已删除`,"success"))}function addCommandField(){const e=document.getElementById("commandsList"),t=document.createElement("div");t.className="command-item",t.innerHTML=`\n        <div class="command-inputs">\n            <div class="form-group" style="margin: 0;">\n                <label class="form-label">命令名称</label>\n                <input type="text" class="form-input" name="command_name" placeholder="例如：开灯" required>\n            </div>\n            <div class="form-group" style="margin: 0;">\n                <label class="form-label">路径</label>\n                <input type="text" class="form-input" name="command_path" placeholder="例如：/relay/on" required>\n            </div>\n        </div>\n        <div style="text-align: center; margin-top: 0.5rem;">\n            <button type="button" class="remove-command-btn" onclick="this.closest('.command-item').remove()">删除命令</button>\n        </div>`,e.appendChild(t)}function resetCommandsList(){document.getElementById("commandsList").innerHTML=`\n        <div class="command-item">\n            <div class="command-inputs">\n                <div class="form-group" style="margin: 0;"><label class="form-label">命令名称</label><input type="text" class="form-input" name="command_name" value="设备状态" readonly></div>\n                <div class="form-group" style="margin: 0;"><label class="form-label">路径</label><input type="text" class="form-input" name="command_path" value="/status" readonly></div>\n            </div>\n            <div style="text-align: center;"><span style="color: var(--text-secondary); font-size: 0.75rem;">默认命令</span></div>\n        </div>`}function fillCommandsList(e){const t=document.getElementById("commandsList");t.innerHTML="",resetCommandsList();const n=e.filter(e=>"/status"!==e.path);for(const e of n){const n=document.createElement("div");n.className="command-item",n.innerHTML=`\n            <div class="command-inputs">\n                <div class="form-group" style="margin: 0;"><label class="form-label">命令名称</label><input type="text" class="form-input" name="command_name" value="${sanitizeInput(e.name)}" required></div>\n                <div class="form-group" style="margin: 0;"><label class="form-label">路径</label><input type="text" class="form-input" name="command_path" value="${sanitizeInput(e.path)}" required></div>\n            </div>\n            <div style="text-align: center; margin-top: 0.5rem;"><button type="button" class="remove-command-btn" onclick="this.closest('.command-item').remove()">删除命令</button></div>\n        `,t.appendChild(n)}}function getDeviceIcon(e){let t=e.toLowerCase();return t.includes("灯")||t.includes("light")?'<i class="fas fa-lightbulb"></i>':t.includes("风扇")||t.includes("fan")?'<i class="fas fa-fan"></i>':t.includes("空调")||t.includes("ac")?'<i class="fas fa-snowflake"></i>':t.includes("开关")||t.includes("switch")?'<i class="fas fa-plug"></i>':t.includes("传感器")||t.includes("sensor")?'<i class="fas fa-satellite-dish"></i>':'<i class="fas fa-home"></i>'}function getControlIcon(e){let t=e.toLowerCase();return t.includes("开")||t.includes("on")?'<i class="fas fa-power-off"></i>':t.includes("关")||t.includes("off")?'<i class="fas fa-times-circle"></i>':t.includes("灯")||t.includes("light")?'<i class="fas fa-lightbulb"></i>':t.includes("风扇")||t.includes("fan")?'<i class="fas fa-fan"></i>':t.includes("空调")||t.includes("ac")?'<i class="fas fa-snowflake"></i>':t.includes("温度")?'<i class="fas fa-thermometer-half"></i>':t.includes("湿度")?'<i class="fas fa-tint"></i>':'<i class="fas fa-cog"></i>'}function isControlDisabled(e,t){let n=e.name.toLowerCase(),o="";return t.info&&t.info.current_state&&(o=t.info.current_state.toLowerCase()),n.includes("开")||n.includes("on")?o.includes("开")||o.includes("on"):n.includes("关")||n.includes("off")?o.includes("关")||o.includes("off"):!1}

document.addEventListener("DOMContentLoaded", () => {
    NetworkMonitor.init();
    loadAppData();
    updateProxyStatus();
    renderDevicesList(); // This will call updateStats()
    if (proxyConfig.url) {
        startListPolling();
    }
});

document.getElementById("deviceForm").addEventListener("submit", e => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const name = formData.get("name"), ip = formData.get("esp_ip"), port = parseInt(formData.get("esp_port")), timeout = parseInt(formData.get("timeout"));
    if (!name || !ip || !port || !timeout || !isValidIP(ip) || !isValidPort(port)) {
        showToast("请检查所有字段是否有效", "error");
        return;
    }
    const commands = formData.getAll('command_name').map((n, i) => ({ name: n, path: formData.getAll('command_path')[i] })).filter(c => c.name && c.path);
    if (isEditMode) {
        const device = devices.find(d => String(d.id) === String(editingDeviceId));
        if (device) Object.assign(device, { name, esp_ip: ip, esp_port: port, timeout, commands });
    } else {
        devices.push({ id: Date.now(), name, esp_ip: ip, esp_port: port, timeout, commands, status: 'offline', info: {} });
    }
    saveDevices();
    renderDevicesList();
    closeDeviceModal();
    showToast(isEditMode ? '设备已更新' : '设备已添加', 'success');
});

document.getElementById("proxyConfigForm").addEventListener("submit", e => {
    e.preventDefault();
    proxyConfig.url = document.getElementById('proxyUrl').value;
    proxyConfig.timeout = parseInt(document.querySelector('[name="proxy_timeout"]').value, 10);
    if (!proxyConfig.url) { showToast("代理地址不能为空", "error"); return; }
    saveProxyConfig();
    updateProxyStatus();
    closeProxyConfigModal();
    showToast('代理配置已保存', 'success');
    startListPolling();
});

document.getElementById("deviceModal").addEventListener("click", e => { if (e.target === e.currentTarget) closeDeviceModal(); });
document.getElementById("proxyConfigModal").addEventListener("click", e => { if (e.target === e.currentTarget) closeProxyConfigModal(); });
document.getElementById("confirmDialog").addEventListener("click", e => { if (e.target === e.currentTarget) closeConfirmDialog(); });

document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        if (document.getElementById("deviceModal").classList.contains("show")) closeDeviceModal();
        else if (document.getElementById("proxyConfigModal").classList.contains("show")) closeProxyConfigModal();
        else if (document.getElementById("confirmDialog").classList.contains("show")) closeConfirmDialog();
        else if (document.getElementById("detailView").classList.contains("show")) showListView();
    }
});