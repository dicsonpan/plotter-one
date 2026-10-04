#!/bin/bash
# 刻字机 Web 控制服务 —— Armbian / RK3399 一键安装
#
# 做的事：
#   1. 检查 Node.js，没装就装（Armbian 官方源或 NodeSource）
#   2. 拷贝工程到 /opt/plotter-one
#   3. 建专用系统用户，授予串口权限（dialout 组）
#   4. 装 systemd 服务，开机自启
#   5. 配 udev 规则（可选，让普通用户也能读写串口）
#   6. 配防火墙放行端口
#   7. 配 mDNS（局域网用 hostname.local 访问，省去记 IP）
#
# 用法：sudo bash deploy/install.sh [--port 8080]

set -e

PORT=8080
INSTALL_DIR=/opt/plotter-one
SERVICE_USER=plotter
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

echo ""
echo "  刻字机 Web 控制服务 安装程序"
echo "  ─────────────────────────────────────────"
echo "  安装目录：$INSTALL_DIR"
echo "  服务端口：$PORT"
echo "  源目录  ：$SRC_DIR"
echo ""

if [ "$(id -u)" != "0" ]; then
  echo "✗ 需要 root 权限，请用 sudo 运行"
  exit 1
fi

# ---------------------------------------------------------------- Node.js
echo "▸ 检查 Node.js…"
if ! command -v node > /dev/null 2>&1; then
  echo "  未安装，开始安装 Node.js 18+…"
  apt-get update -qq
  if apt-cache show nodejs 2>/dev/null | grep -q '"18\.\|"20\.\|"22\.'; then
    apt-get install -y -qq nodejs
  else
    echo "  系统源版本过旧，改用 NodeSource…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi
fi
NODE_V=$(node -v)
echo "  ✓ Node.js $NODE_V"

# ---------------------------------------------------------------- 文件
echo "▸ 拷贝工程文件…"
mkdir -p "$INSTALL_DIR"
# 只拷运行必需的部分，排除 node_modules 与临时文件
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'data/config.json' \
  "$SRC_DIR"/server "$SRC_DIR"/web "$SRC_DIR"/package.json "$INSTALL_DIR"/ 2>/dev/null || {
    cp -r "$SRC_DIR"/server "$SRC_DIR"/web "$SRC_DIR"/package.json "$INSTALL_DIR"/
  }
mkdir -p "$INSTALL_DIR/data"
echo "  ✓ 已安装到 $INSTALL_DIR"

# ---------------------------------------------------------------- 用户
echo "▸ 配置服务用户…"
if ! id "$SERVICE_USER" > /dev/null 2>&1; then
  useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
  echo "  ✓ 已创建用户 $SERVICE_USER"
fi
# dialout 组是访问 /dev/ttyUSB* 的前提条件
usermod -aG dialout "$SERVICE_USER"
echo "  ✓ 已加入 dialout 组（串口访问权限）"

# ---------------------------------------------------------------- systemd
echo "▸ 安装 systemd 服务…"
cat > /etc/systemd/system/plotter-one.service << EOF
[Unit]
Description=刻字机 Web 控制服务
Documentation=file://$INSTALL_DIR/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server/index.js --port $PORT --host 0.0.0.0
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=plotter-one

# 串口设备热插拔后服务要能自动恢复
WatchdogSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable plotter-one > /dev/null 2>&1
systemctl restart plotter-one
sleep 2
echo "  ✓ 服务已启动"

# ---------------------------------------------------------------- udev
echo "▸ 配置串口权限规则…"
cat > /etc/udev/rules.d/99-plotter-serial.rules << 'EOF'
# 让 dialout 组用户可读写 USB 转串口设备
# 常见 VID:PID —— CH340(1a86:7523) CH341(1a86:5523) FTDI(0403:6001) PL2303(067b:2303) CP210x(10c4:ea60)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", MODE="0660", GROUP="dialout"
EOF
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
echo "  ✓ 规则已安装（拔插串口后生效）"

# ---------------------------------------------------------------- 防火墙
echo "▸ 配置防火墙…"
if command -v ufw > /dev/null 2>&1; then
  ufw allow "$PORT"/tcp > /dev/null 2>&1 && echo "  ✓ ufw 已放行 $PORT" || echo "  ! ufw 放行失败，请手动检查"
elif command -v firewall-cmd > /dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT"/tcp > /dev/null 2>&1
  firewall-cmd --reload > /dev/null 2>&1
  echo "  ✓ firewalld 已放行 $PORT"
else
  echo "  ! 未检测到防火墙，跳过"
fi

# ---------------------------------------------------------------- mDNS
echo "▸ 配置局域网发现…"
if ! command -v avahi-daemon > /dev/null 2>&1; then
  apt-get install -y -qq avahi-daemon avahi-utils 2>/dev/null && {
    cat > /etc/avahi/services/plotter-one.service << EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service">
<service-group>
  <name replace-wildcards="yes">刻字机控制台</name>
  <service>
    <type>_http._tcp</type>
    <port>$PORT</port>
    <text-record>刻字机 Web 控制台</text-record>
  </service>
</service-group>
</service-group>
EOF
    systemctl enable avahi-daemon > /dev/null 2>&1
    systemctl restart avahi-daemon
    echo "  ✓ mDNS 已配置（用 hostname.local 访问）"
  } || echo "  ! mDNS 安装跳过，可直接用 IP 访问"
else
  echo "  ✓ avahi 已安装"
fi

# ---------------------------------------------------------------- 完成
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  ─────────────────────────────────────────"
echo "  ✓ 安装完成"
echo ""
echo "  本机访问：http://localhost:$PORT"
[ -n "$IP" ] && echo "  局域网访问：http://$IP:$PORT"
echo "  手机访问：连同一 Wi-Fi，浏览器输上面地址"
echo ""
echo "  常用命令："
echo "    查看日志：journalctl -u plotter-one -f"
echo "    重启服务：systemctl restart plotter-one"
echo "    停止服务：systemctl stop plotter-one"
echo "    开机自启：systemctl enable plotter-one"
echo ""
echo "  下一步："
echo "    1. 用 USB 线把刻字机接到板子上"
echo "    2. 浏览器打开控制台，选择串口设备（一般形如 /dev/ttyUSB0）"
echo "    3. 先用「内置虚拟机」模式熟悉操作，再切到真实串口"
echo ""
echo "  ⚠ 首次上机建议：先空跑（不放材料）确认方向和原点，再放料刻"
echo ""
