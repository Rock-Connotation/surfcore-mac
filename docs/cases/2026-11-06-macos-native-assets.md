# macOS arm64 FFmpeg/FFprobe 隔离构建

## 目标与环境

为 macOS 媒体理解准备不依赖 Homebrew 的本地工具，避免 Finder 环境缺 PATH 或把本机 Homebrew 动态依赖带入制品。仅在 macOS 26.6.2 arm64、Apple clang 21.0.0 测试；未推断 Intel 或其他系统版本。

## 取舍、来源与许可

直接复制 Homebrew 的动态工具成本低，但其外部库及许可随本机变化，难以移植和交接。选择以官方源码固定构建静态 FFmpeg 库、禁用外部依赖：成本是本机编译及后续安全/许可维护；程序仍动态链接 Apple 系统库，不能称为全静态。保留源码和构建信息即可独立回退或重建。

官方 release 页列出 9.0.2；本机直连 `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz` TLS 超时，因此从官方 `https://github.com/FFmpeg/FFmpeg.git` 获取 `n9.0.2`，提交 `946fcce07b6dcd0331c8cc609192aeff5e1924f8`、tree `f314f188666de54687c464fc975e5ee43fae26e1`。本地 Git archive 的 SHA-256 为 `d250dbe3301b5645d45adadc19a10d5c57a046f22ea731c7e2bc68d43aa6cdee`，98,723,840 字节；它不是官方 tarball。缺少 gpg，`git verify-tag` 未完成，签名**未验证**。源码副本保存在 `_backups/macos-native-assets/downloads/ffmpeg-9.0.2-git-946fcce.tar`。

`scripts/prepare-macos-media.mjs` 只接受干净且固定提交的本地源码、拒绝覆盖已有输出，不自动下载。configure 为 `--disable-autodetect --disable-network --disable-doc --disable-debug --enable-static --disable-shared --disable-ffplay`；配置报告 `License: LGPL version 2.1 or later`，无外部库，未启用 GPL/nonfree。许可证文件与配置随本地 bundle 保存；正式分发前仍须核实完整源码提供及 LGPL 义务。

## 完整逻辑与验证

1. **链路**：应用媒体解析器通过 FFmpeg/FFprobe 绝对路径调用子进程；本资产未安装进应用或修改自动发现配置。
2. **机制**：源码构建静态 FFmpeg 内部库，仅链接系统库；网络关闭，媒体输入必须先由已有下载流程保存为本地文件。
3. **影响面**：影响媒体解码、抽帧及 ASR 音频转换；不修改账号、配置、运行服务或用户内容。恶意媒体仍可触发上游漏洞。
4. **路线与回滚**：上述源码构建替代依赖本机 Homebrew 的复制。测试资产隔离在 `_backups/macos-native-assets/`，不启用即无需回滚；删除前按仓库隔离规则处理。
5. **生效**：尚未接入产品；未来集成需使用经验证的路径并重载实际宿主，不能把本次离线结果当宿主验收。
6. **验证**：`node --check scripts/prepare-macos-media.mjs` 和隔离构建均通过；`smoke.log` 证明 H.264/AAC 读取、16 kHz 单声道 PCM 输出、scene 检测、scale/tile/crop 和 JPEG 输出及实际流信息；另测内置 lavfi sine。以 PATH 仅含系统目录运行，`file` 为 arm64，`otool -L` 仅 `/usr/lib` 与 `/System/Library`，两程序模式 755。`resolver.log` 证明实际媒体解析器识别两个显式路径并确认能力。
7. **残余**：未做 DSH/Finder 真实集成、Intel、旧系统和全部媒体格式验证。GitHub 未审阅公告 [CVE-2026-107678](https://github.com/advisories/GHSA-rp4v-7m3g-89vg) 称至 9.0.2 的构造 MP4 可导致资源耗尽，修复状态未知；发布前需核实上游修复和输入风险。签名未验证、许可及源码提供方式待核实，因此该资产不视为已批准发布。

本地资产：`_backups/macos-native-assets/bundle-darwin-arm64/`，包含可执行文件、许可证、配置和 `asset-manifest.json`。二进制 SHA-256：FFmpeg `65044c6b19e270c00d0d3494a872bf2bc9d55010f97c16bec53076f41fd16dd2`；FFprobe `9ff1f4934974b2aef8c8c7baf7b9135da4b0dd51ffda8789ed617d54bdb368dd`。日志位于同目录上一级 `build.log`、`smoke.log`、`resolver.log`。

## 可转发发布交接

```text
改动：新增固定源码的离线构建脚本和隔离 arm64 媒体资产；未改应用接线或发布。
验证：构建、系统链接检查、H.264/AAC、PCM 重采样、场景与 JPEG 拼图、lavfi、媒体解析器通过，证据见本 case。
建议版本：由完整 macOS 交付范围决定；用户决定最终版本。
接口与影响：工具路径需由集成层选择；禁网络，要求输入先落本地；仅验证 macOS 26.6.2 arm64。
失败与遗留：官方 tar TLS 超时，Git tag 签名未验证；9.0.2 安全公告及 LGPL 源码提供需发布前处理；真实宿主与其他平台未验收。
case：docs/cases/2026-11-06-macos-native-assets.md。
```
