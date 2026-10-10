# 部署记录：wifi 棒子（192.168.11.165）

部署日期：2026-10-05
设备：`klipper@192.168.11.165`，root / `P@ssw0rd`

## 设备画像

| 项 | 值 |
|---|---|
| 硬件 | 高通骁龙 410（msm8916），wifi 棒子形态 |
| 架构 | aarch64 |
| 内存 | 379 MiB |
| 交换 | 1G 磁盘 swapfile `/swapfile`（btrfs 上必须 `chattr +C` 关 COW，否则 swapon 失败；原为 190M zram，已 `disable`） |
| 磁盘 | 3.3 GB eMMC（/dev/mmcblk0p14） |
| 系统 | Debian 11 bullseye（Mobian 定制镜像） |
| 内核 | `5.18.0-msm8916mainline+`（主线定制，非 Debian 官方） |
| 网络角色 | 客户端（默认网关 192.168.11.1），另有 nm-bridge 192.168.68.1 处于 linkdown |

**重要约束**：这是 Mobian 定制镜像 + 定制主线内核。`apt` 源里没有对应内核包，**不要执行 `dist-upgrade`**——会替换内核导致设备失联，且没有救援通道。

## 部署结果

- 访问地址：**http://192.168.11.165/**（80 端口）
- 安装目录：`/opt/plotter-one`
- 服务用户：`plotter`（已加入 `dialout` 组，可访问 `/dev/ttyUSB*`）
- systemd：`plotter-one.service`，已 enable 开机自启
- Node.js：v24.21.0 LTS，装在 `/opt/node`，软链到 `/usr/local/bin`

### 为什么服务用非 root 却能绑 80

绑定 1024 以下端口需要 `CAP_NET_BIND_SERVICE`。单元里加了：

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

不这么做会直接 `EACCES: permission denied 0.0.0.0:80`。

### 内存保护

单元里设了 `MemoryMax=200M`。实测常驻约 58 MB，但这机器只有 379 MiB，不加限制容易把 NetworkManager 挤死。

## 常用命令

```bash
ssh root@192.168.11.165

systemctl status plotter-one
systemctl restart plotter-one
journalctl -u plotter-one -f        # 看日志
curl -s localhost/api/state        # 查状态
```

改代码后重新部署（在项目目录执行）：

```bash
tar czf /tmp/plotter-one.tar.gz \
  --exclude='.git' --exclude='.workbuddy' --exclude='node_modules' \
  --exclude='data/config.json' server web package.json

scp /tmp/plotter-one.tar.gz root@192.168.11.165:/root/
# 设备上：tar xzf /root/plotter-one.tar.gz -C /opt/plotter-one && chown -R plotter:plotter /opt/plotter-one && systemctl restart plotter-one
```

## apt 源配置（重要）

`/etc/apt/sources.list`：

```
deb https://mirrors.tuna.tsinghua.edu.cn/debian/ bullseye main contrib non-free
deb https://mirrors.tuna.tsinghua.edu.cn/debian/ bullseye-updates main contrib non-free
deb http://archive.debian.org/debian-security/ bullseye-security main contrib non-free
```

**为什么 security 必须走 archive.debian.org**：bullseye 归档期间，Debian 从主仓撤下了一批旧版本文件，但 `Packages` 索引里的记录没同步删除。结果是在 `deb.debian.org` 和 tuna 上都返回 404（`dpkg`、`perl`、`sudo`、`libxml2`、`libglib2.0-0`、`libsodium23`、`libcurl4`、`git`、`dnsmasq`、`libpam-modules` 等约 20 个包）。`archive.debian.org` 保留全部历史版本，是归档期的正解。

主仓/updates 走 tuna 是因为速度：tuna 约 1.5 MB/s，官方源只有 13 KB/s。

还配了 `/etc/apt/apt.conf.d/99-compress` 关掉 Translation 下载，索引只取 `.gz`。

## 大批量装包的办法：本地下载 + SCP

设备到 `archive.debian.org` 只有约 10 KB/s（Mac 上是 1.4 MB/s，差 140 倍）。65 MB 的升级包在设备上要跑几十分钟，在 Mac 上 8 并发下载只要几十秒。

```bash
# 设备上导出清单
apt-get --print-uris -y upgrade | grep -oE "'http[^']+'" | tr -d "'" > /root/uris.txt
scp root@192.168.11.165:/root/uris.txt .

# Mac 上并行下载（注意 %2b 要还原成 +）
sed 's|%2b|+|g' uris.txt | xargs -P 8 -n 1 ./dl.sh

# 打包传回，设备上 dpkg -i
tar czf debs.tar.gz *.deb
scp debs.tar.gz root@192.168.11.165:/root/
# 设备上：tar xzf debs.tar.gz -C /root/debs && dpkg -i /root/debs/*.deb && dpkg --configure -a
```

## 踩过的坑

### 1. `apt-get autoremove` 会删掉 `iproute2` 和 `python3`

Mobian 镜像里这两个包是手动装的，dpkg 不知道谁依赖它们，`autoremove` 判定为孤儿直接删。删掉之后 `ip` 命令消失，`/usr/sbin/mobian-setup-usb-network` 脚本失效。

**已用 `apt-mark hold` 锁住**（iproute2、python3、python3-minimal、libpython3-stdlib、libpython3.9、libpython3.9-stdlib、python3.9）。以后跑 autoremove 前先想一下这台机器的特殊性。

### 2. 删掉之后 apt 装不回来

重新安装时 apt 仍去拉那个被撤下的新版本（`python3.9_3.9.2-1+deb11u7`），继续 404。绕法是**直接下载 main 池的老版本 deb 手动 dpkg 装**：

```bash
# 注意两点：路径要从索引里 awk 出来（包在 python3-defaults 源包下，不在 python3.9/ 下），
# 架构是 arm64 不是 all；版本号带 epoch 的要去掉前缀
curl -O https://mirrors.tuna.tsinghua.edu.cn/debian/pool/main/p/python3-defaults/python3_3.9.2-3_arm64.deb
dpkg -i *.deb
dpkg --configure -a --force-depends
```

`libpython3-minimal` 在 arm64 索引里根本不存在（只在 all），最终用 `--force-depends` 收尾——实测 `python3` 标准库完整，不影响使用。

### 3. 长命令会被 SIGTERM 打断

apt 在这台 379 MiB 的机器上跑久了，SSH 连接会被杀。**所有耗时操作都要 `setsid nohup` 后台跑 + 写日志**，然后轮询日志文件。

被 SIGTERM 打断的 apt 进程会留下僵死的 `/var/lib/apt/lists/lock`，下次 apt 报「无法获得锁」。清理：

```bash
pkill -9 apt-get; rm -f /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock-frontend
```

### 4. `systemctl is-active ssh` 显示 inactive 是正常的

Debian 新版用 socket activation，sshd 由 systemd 直接持有 22 端口，没有常驻进程。判断 SSH 是否正常要看 `ss -tln | grep ':22'`，不要看 `is-active`。

## 系统更新成果

79 个包升级到 bullseye 内的最新版，dpkg 审计干净：

| 包 | 版本 |
|---|---|
| libc6 | 2.31-13+deb11u14 |
| systemd | 247.3-7+deb11u8 |
| openssh-server | 1:8.4p1-5+deb11u7 |
| sudo | 1.9.5p2-3+deb11u4 |
| perl | 5.32.1-4+deb11u5 |
| libxml2 | 2.9.10+dfsg-6.7+deb11u10 |
| libssl1.1 | 1.1.1w-0+deb11u8 |
| tzdata | 2026b-0+deb11u1 |

剩 5 个 `python3.9-*` 停在 3.9.2-1（u7 版要从 archive 下 1.55 MB，太慢不值得）。用着没问题。

**未做 dist-upgrade**——见上文「设备画像」的约束说明。

## klipper 卸载记录

原设备跑的是 k3ros 系的 klipper 3D 打印固件栈。卸载前备份在 `/root/klipper-backup-20261005-210356/`（20 KB，含 printer.cfg、moonraker.conf、kiauh 配置、systemd 单元、nginx 配置）。

清除内容：

- 服务：`klipper.service`、`moonraker.service`、`nginx.service`（停止 + disable）
- 文件：`/home/klipper`（694 MB，含 klipper/moonraker 源码、fluidd、kiauh、printer_data、两个 Python venv）
- `/app/CameraPusher.jar` + `camerapusher.yaml`（74 MB，远程相机推流）
- nginx 站点配置（`sites-available/fluidd`、`conf.d/upstreams.conf`、`common_vars.conf`）与 nginx 包本身
- 用户 `klipper` 及其 sudo/polkit 授权
- klipper 装的 Python 构建依赖（`python3-virtualenv`、`python3-dev`、`libpython3-dev`）
- 全盘扫描确认零残留（`klipper` / `moonraker` / `fluidd` / `kiauh`）

**保留未动**：Mobian 基础设施（`mobian-usb-gadget`、`mobian-setup-usb-network`、`qrtr-ns`）、`NetworkManager`、`wpa_supplicant`、`dnsmasq`、Serial-getty。

## 遗留待办

- [ ] 刻字机还没接上，串口未配置。接上后在界面选 `/dev/ttyUSB*` 即可（udev 规则已配好 CH340/FTDI/PL2303/CP210x 权限）
- [ ] 5 个 python3.9 包若要升到 u7，得从 Mac 下载 deb 再 SCP 过去
- [ ] hostname 还是 `klipper`，既然 klipper 没了可以考虑改成 `plotter-stick` 之类（要改的话注意 mobian 相关配置是否引用了主机名）
