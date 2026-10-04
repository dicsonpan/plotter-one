#!/bin/bash
# 卸载刻字机 Web 控制服务
# 用法：sudo bash deploy/uninstall.sh [--purge]

set -e

PURGE=0
INSTALL_DIR=/opt/plotter-one
SERVICE_USER=plotter

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "✗ 需要 root 权限"
  exit 1
fi

echo "▸ 停止服务…"
systemctl stop plotter-one 2>/dev/null || true
systemctl disable plotter-one 2>/dev/null || true

echo "▸ 移除 systemd 配置…"
rm -f /etc/systemd/system/plotter-one.service
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

echo "▸ 移除 udev 规则…"
rm -f /etc/udev/rules.d/99-plotter-serial.rules
udevadm control --reload-rules 2>/dev/null || true

echo "▸ 移除 mDNS 服务…"
rm -f /etc/avahi/services/plotter-one.service

if [ "$PURGE" = "1" ]; then
  echo "▸ 删除程序目录（含配置与历史）…"
  rm -rf "$INSTALL_DIR"
  echo "▸ 删除服务用户…"
  userdel "$SERVICE_USER" 2>/dev/null || true
  echo "✓ 已完全清除（含配置数据）"
else
  echo "✓ 已卸载，程序目录保留在 $INSTALL_DIR"
  echo "  如需彻底清除：sudo bash deploy/uninstall.sh --purge"
fi
