# macOS 共享本地 ASR（2026-11-06）

## 现象与环境

macOS 首期需要本地音轨转写及来源覆盖证据；原仓库没有 Host 统一 ASR 队列。测试在隔离数据根执行，Apple Silicon macOS，Node 26.5.1，whisper.cpp commit `d1be6fde11ac6e0407606b4e42fe72d34add8037` 构建报告 `1.9.5-dev`，FFmpeg/FFprobe 为本机 Homebrew 版本。资产来自 WP0 隔离目录；没有访问真实 profile、平台账号或用户音频。

## 完整逻辑

1. **链路**：本地维护 CLI 与渠道客户端调用 Host perception API，Host 的 `plugins/surfcore/lib/perception.js` 将请求交给 `src/perception/service.js`，再经 `media.js` 和 `whisper.js` 调用本机 FFprobe、FFmpeg 与 whisper.cpp。角色和 activity 在提交时冻结，结果与来源、覆盖一起返回；不直接写记忆。
2. **机制**：注册素材须位于受管资产目录，realpath 和 SHA-256 均须验证；模型摘要和引擎版本在缓存命中前仍核验。音频先转 16kHz 单声道 PCM，再按源时间映射分块；覆盖取成功处理区间与已获取区间交集，实际 PCM 短于容器声明时限制到实际样本。语音为空不自动等同静音，只有完整精确零采样才标记 no_speech。队列先持久化再应答；同键消费者共享推理，最后消费者取消时终止并等待子进程。重启中的 running 变 interrupted，恢复前重新校验当前角色与 epoch，旧 epoch 拒绝恢复；建立新作业并验证检查点。热重载立即停止旧实例准入，新实例有界等待锁；超时后下一次调用可再尝试，不抢锁。
3. **影响面**：每个数据根只有一个 Host 锁和一个推理槽；影响接入该服务的所有渠道和本地 CLI。输入、结果、检查点落在受限数据目录，公开作业剥离本机路径与 URL 凭据；不接触资金、平台凭据和外发。缺模型显示 code/error/hint，不影响 Host 启动。
4. **取舍**：渠道各自启动识别进程成本低但无法统一资源、取消和覆盖管理；Host 单队列增加持久化和进程管理成本，收益是跨渠道资源与恢复一致，停用模块即可回滚。缓存键额外包含角色和 epoch，隐私更保守但跨角色去重复用机会减少；实际范围授权注册仍需后续对接，不能仅凭请求声明证明访问权限。
5. **生效与重启**：源码和插件 Host 导入在宿主加载时生效；真实 DSH 需按主会话的安装授权和重启流程重新加载。未重启现有 DSH，未修改 profile。
6. **验证**：`node scripts/test-perception-service.mjs` 覆盖截断、源时间映射、来源未知、无音轨、精确静音与未知、资产/模型摘要失败、忙时拒配、消费者取消、实际子进程退出、旧 epoch 恢复拒绝、热重载与锁超时再恢复，及 241 秒生成音频跨两块覆盖；`ASR_ASSETS=<已验证资产目录> node scripts/test-perception-real.mjs` 以真实 base 模型及中文样本验证 0–6463ms 完整覆盖。`npm run test:audit` 144/144、插件 `npm test` 退出 0。`scripts/test-perception-cli.mjs` 使用 WP4 客户端、真实 Host API handler 与隔离队列完成 local submit/inspect，校验公开返回不含 request、角色缺失与旧 epoch 拒绝；正式合并后的目标 DSH/B站实机仍待验。
7. **回滚与残余**：移除 Host 接线或恢复该功能提交，保留 perception 数据目录作证据，不删除模型和用户文件。未验证 Intel、Metal、实际长媒体和目标 DSH/B站闭环；单条带噪中文样本存在识别错误，不能据此宣称质量达标。缓存和检查点校验并非针对有写权限的恶意篡改者的认证机制。

## 发布交接块

- 范围：共享本地 ASR 服务、受管素材、覆盖与来源、Host 单槽队列、取消/恢复、诊断和本地维护 CLI。
- 影响：需 Host 加载新代码；缺模型可诊断，不自动下载、不调用云端。
- 已验证：隔离测试、真实中文样本 base CPU、audit 144/144、插件全量退出 0；隔离 CLI/Host 组合通过；实际 DSH、B站、Intel/Metal 和发行包待验。
- 回滚：恢复 Host 接线与代码，保留 perception 数据；不删除资产和模型。
- 版本及发布：本次不 bump、不发布，待发布会话按门禁与用户确认处理。

## 2026-11-06 补充：普通话模型对比（隔离评估）

素材为 AISHELL-1 测试集两段、同一说话人，取自 icefall 示例仓库固定 revision `a227b40c9fd425cce49eb0c732d980edc763e1cc` 的 `test_wavs/`，连同该目录 `transcript.txt`。上游 [AISHELL-1 数据卡](https://huggingface.co/datasets/AISHELL/AISHELL-1)标注 Apache-2.0、安静室内、16kHz，并说数据供学术使用；[icefall 样本目录](https://huggingface.co/csukuangfj/icefall-aishell-transducer-stateless-modified-2-2022-03-01/tree/a227b40c9fd425cce49eb0c732d980edc763e1cc/test_wavs)发布样本与参考文本。下载仅三文件，共约 267 kB，未下载模型或完整数据集。`0121.wav` SHA-256 `46dbc998c9d1d48111267c40741dd3200f2e5bcf4075f8c4c97f4451160dce50`；`0122.wav` `5760c7ace0923a499f605d373011c7aaf658e304a0999a493c63669c756384e1`；参考文本 `79c4fc4acb4f8a21444280c50e1c8e543748164b9058965b1c631fd123db7b8f`。

同一共享服务、zh、两模型、CPU 与 Metal 各两次；每次采用新的受限范围避免结果缓存。逐字 CER 先做 NFKC 并去空格和标点，数字不转汉字，编辑距离除以参考字数。两段均验证获取和处理覆盖完整、无缺口；不能用最后一句结束时间判断覆盖。

| 样本 | 参考 | base（两后端一致） | small（两后端一致） |
| --- | --- | --- | --- |
| 0121，4.204s | 甚至出现交易几乎停滞的情况 | 甚至出现交易几乎停止的情况；1/13 = 7.69% | 相同，0/13 = 0% |
| 0122，4.115s | 一二线城市虽然也处于调整中 | 1/2线尝试虽然也处于调整中；4/13 = 30.77% | 相同，0/13 = 0% |

关键短语“停滞”和“一二线城市”在 base 中均有错误，small 正确；该结论只覆盖这两条短句。Apple M4、macOS 26.6.2、16 GiB、whisper.cpp 报告 1.9.5-dev、base/small 模型摘要与 WP0 资产记录一致。16 次作业耗时（包含 Host 验证、规范化、进程启动和转写）及采样的推理子进程峰值 RSS：

| 后端 | 模型 | 四次耗时 ms（逐样本先后两次） | RSS 范围 KiB |
| --- | --- | --- | --- |
| CPU | base | 727, 632, 683, 579 | 363712–366432 |
| CPU | small | 1620, 1305, 1397, 1831 | 789152–851248 |
| Metal | base | 615, 481, 605, 580 | 373392–378976 |
| Metal | small | 1024, 786, 892, 787 | 809696–866144 |

日志确认 CPU 请求 `use gpu = 0`，Metal 使用 MTL0 后端。RSS 为 100ms 间隔采样的子进程驻留内存，不含可独立归属的 GPU 内存，也不是系统峰值；短作业可能低估。首次与重复均创建新推理进程，OS 缓存未清空，且 doctor 预读模型做摘要核验，因此不能称为严格冷启动；重复也不是常驻模型热推理。参考文本和模型之间可能存在训练集重叠，未做污染排查。此前有噪体育样本只是一条，不能由这两条清晰同人样本外推口音、专名、音乐或长视频质量。

**建议**：暂以 small 为默认候选、允许低资源设备选择 base：两句中 small 零字错且多占约 0.4–0.5 GiB 子进程 RSS；但仍需更宽样本、资源与发行机器验证后才能冻结默认和质量门槛，本次不更改产品默认。

可复现：按上面的固定 revision 下载两个命名 WAV 与 `transcript.txt` 至 `_backups/asr-quality-aishell/`；检查摘要，再在 ASR 工作树执行 `node scripts/test-perception-benchmark.mjs`。用 `ASR_BENCH_SAMPLES=<样本目录> ASR_ASSETS=<WP0资产目录> node scripts/test-perception-benchmark.mjs`；FFmpeg/FFprobe 从 PATH 发现，或通过 `FFMPEG_PATH` 与 `FFPROBE_PATH` 指定可执行文件绝对路径；缺失依赖会明确报阻塞。原始输出 `_backups/asr-quality-benchmark.log`，此次逐次日志与 JSON 在 `_backups/asr-quality-run-1793960425614-95034/`。16 次均 exit 0；实际 DSH/B站和发行物未验。

可移植性复核：真实推理脚本与基准脚本必须提供绝对路径 `ASR_ASSETS`，未设置或缺文件以结构化阻塞退出；通用夹具缺 FFmpeg/FFprobe 时先运行纯区间逻辑断言，再报告媒体验证阻塞。CLI 从指定状态根同步读取 `characters/current.json` 与角色目录，缺失时提示先在官方 App 创建或选择角色；高级参数可明确指定 ID/epoch，Host 对过期身份拒绝。新增 ASR 路径未在 Windows 验证，原有 Windows 功能仍需整体回归。

## 2026-11-06 补充：修复 whisper 原生制品加载路径

原构建的 `whisper-cli` 的 `LC_RPATH` 是构建工作树里的绝对目录，虽然动态依赖显示为 `@rpath`，单独复制 CLI 即会找不到六个库。构建进程的成功不能证明发行制品可迁移。

比较两条路线：重新构建并验证静态链接可以减少运行时文件，但需要重新确定构建配置、授权与兼容矩阵；在已验证的二进制副本上只修正加载路径，保留已构建后端，成本较低且源资产只读，但需携带六个库、重新签名与逐机验证。此阶段选后者，待正式发行时仍需声明原生资源许可和架构范围。

`node scripts/package-whisper-runtime.mjs --source-bin <绝对build/bin目录> --source-dir <绝对whisper源码目录> --out <不存在的绝对输出目录>`：校验固定源码归档摘要、源码 MIT 通知与归档一致、组件与 arm64 架构；将 CLI 和六个依赖解引用复制为普通文件，去除构建路径、设置 `@loader_path` 和 `@executable_path`，只允许这些本地库及 macOS 系统依赖。副本 ad-hoc 签名并 `codesign --verify --strict`，manifest 记录源码 commit、归档摘要、构建配置、各文件摘要、模式、架构、加载依赖、签名及测试状态。输出存在时拒绝覆盖；构建源码与模型均未更改。ad-hoc 签名不等于 Apple 公证。

本次产物 `_backups/portable-whisper-20261106-a/`，CPU/Metal 原始日志与 JSON `_backups/portable-whisper-verification-20261106-a/`。将产物移动到独立 `/tmp/surfcore-whisper-relocation.CCeXin/runtime`，清除 `DYLD_LIBRARY_PATH`、`DYLD_FRAMEWORK_PATH` 和 `DYLD_INSERT_LIBRARIES` 后分别对公共中文样本运行 `-l zh -oj`：CPU 明确 `use gpu = 0`，Metal 日志显示实际使用 MTL0 和嵌入式 Metal library，两个 JSON 均有中文结果，退出 0。移动后七文件签名均通过；返回保留目录后再次核验 rpath、普通文件和签名。重复指定现有输出返回 `OUTPUT_EXISTS`，原 manifest 摘要不变。该测试是直接 CLI 推理，不是目标 DSH 或 B 站验收。

当前构建标记 `GGML_NATIVE=ON`，实测 Apple M4、macOS 26.6.2；其他 arm64 机型、干净发行环境、Intel、Apple 公证及正式分发许可仍待验。模型从显式资产目录读取，不包含在本次运行时包。回滚：停用该包、恢复旧配置，保留隔离产物与日志，不覆盖或删除源资产。

补充核对：脚本最终版还将源码目录中的 MIT 通知与固定摘要归档内的原文逐字比较；以最终版在新目录 `_backups/portable-whisper-20261106-b/` 重跑成功，七个二进制摘要与已搬迁、实测的 `a` 版本逐一一致。归档摘要和本机记录能追溯选定源码，但不能单独证明现有二进制一定由该源码和记录的参数构建；正式制品仍需可复现构建证明。

## 2026-11-06 补充：官方 App 随附 Node 与便携运行时组合

在隔离数据根 `_backups/原生 验证 Node24 20261106/`，以官方 DSH App 随附的 Node v24.21.0 arm64 运行 `scripts/verify-native-perception.mjs`；使用便携 whisper `portable-whisper-20261106-a`、便携 FFmpeg/FFprobe 和已核验 small 模型与公共中文样本。进程通过 `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` 启动，未传入任何 DYLD 变量。数据根包含中文和空格，未启动官方 GUI、未访问真实 profile 或网络。

CPU、Metal 各提交一个共享服务作业，实际经历 FFprobe、PCM 规范化、单块转写和覆盖核验；两次 `completed`，请求、获取和处理均为 0–6463 ms，缺失区间为空。CPU 识别段为 0–6000 ms，Metal 为 0–6200 ms，不能由台词结束时间推断覆盖。日志确认 CPU `use gpu = 0`，Metal 使用 MTL 后端与 embedded metal library。CPU 本次耗时 11945 ms，Metal 2152 ms，属于单次端到端观察，不作为性能基准；文本有错字，不作为准确率达标依据。缺失受管音频的服务作业返回 `failed`、`ASSET_UNAVAILABLE`，且 `error`、`hint` 均非空。独立缺失模型入口测试退出 1，返回同码与可行动 hint。

复现时在 ASR 工作树，以系统洁净环境运行官方 App 随附 Node：

```sh
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DSH_NODE" scripts/verify-native-perception.mjs \
  --whisper-dir "$PORTABLE_WHISPER" --media-dir "$PORTABLE_MEDIA_BIN" \
  --model "$SMALL_MODEL" --sample "$PUBLIC_SAMPLE" --out "$NEW_ISOLATED_ROOT"
```

上述参数必须是绝对路径，目标目录必须不存在；模型和样本 SHA-256 必须匹配脚本中的已验证值。结果、哈希与逐后端日志保存在该新目录的 `result.json`、`cpu.stderr.log`、`metal.stderr.log`。本次脚本及 Node `--check` 均退出 0；缺失模型 fixture 按预期退出 1。该测试证明官方随附 Node 与便携依赖的本地组合，**不是官方 App 图形界面或 B站实机验收**；其他 Mac 型号和 Windows 未验。

## 2026-11-06 补充：本地 ASR 资源准入

原单槽队列和子进程超时不能约束单个大素材、排队消费者或 PCM 落盘空间。选择提交与实际探测两级限制：默认每个素材不超过 2 GiB、素材时长不超过 6 小时、最多 32 个等待消费者；可通过服务构造参数 `limits` 明确调整，和 token 预算无关。声明超时长的作业先保存为可检查的失败记录，文件大小在内容摘要前检查；FFprobe 实测时长再次检查，缓存命中也不能绕过。素材实际较短的长源视频可只注册并请求短片段；超过单素材限制须分段或调整本机策略。

队列满时拒绝未接纳的新消费者并给 `ASR_QUEUE_FULL` 与 hint；加入已有运行中推理不占等待名额，取消等待任务释放名额。规范化前检查数据根所在文件系统可用空间，预留 512 MiB，加完整 16kHz 单声道 PCM、所有计划分块以及每块 1 MiB 开销。不可测和不足分别返回 `ASR_DISK_SPACE_UNKNOWN`、`ASR_DISK_SPACE_LOW`；保留失败作业，恢复时重新检查，不自动删除用户文件或回退云服务。检查是时点估算而非磁盘空间预留锁，其他进程仍可能在检查后占用空间，后续写入失败仍需查看原作业错误。

`node scripts/test-perception-resources.mjs` 验证声明超限和文件超限不启动进程、真实探测发现低报时长并阻止 FFmpeg、缓存重试仍探测、磁盘不足/不可测阻止规范化、释放空间后关联恢复、共享推理消费者与等待队列限制；所有失败断言 code/error/hint。`node scripts/test-perception-service.mjs` 含 241 秒双分块完整覆盖回归。两条命令在隔离目录运行；能力未在真实 DSH、Windows 或高并发多进程磁盘争用条件下验收。回滚可移除服务层资源准入及配套模块，保留已有作业和用户素材。
