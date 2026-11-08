# 语音管理与云端/本地引擎边界（2026-11-08）

本次只解决SurfCore语音管理依赖QQ桥接的问题。用户稍后决定引擎；不安装模型、填写密钥、启用麦克风、合成音频或发送QQ。本资料不代表任一真实引擎已验证。

## 资料与结论

| 一手资料 | 核对内容 | 对当前项目的意义 |
| --- | --- | --- |
| [Node24 HTTP生命周期](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback) | 独立server需要自行管理关闭和活跃连接 | 复用DSH现有受保护路由，无需新增管理端口；语音模块不能关闭共享Host服务器 |
| [Node24文件系统](https://nodejs.org/docs/latest-v24.x/api/fs.html) | wx排他创建、EEXIST处理；先检查再写存在竞态 | 共享管理写操作需明确归属，不能靠两个实例各自的Map假设独占 |
| [Node24子进程](https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processspawncommand-args-options) | detached/unref进程可能在父进程退出后继续；发送信号不等于确认退出 | 管理接口可用不代表引擎生命周期已经受控；现有Windows脚本不能冒充Mac支持 |
| [GPT-SoVITS维护者API实现](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py) | 原生合成路由为/tts，需文字/语言/参考音频等参数 | 不能只把地址替换进当前/v1/speak/file客户端；需要本地适配层 |
| [火山官方HTTP单向流式TTS](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh) | 官方/api/v3/tts/unidirectional有独立认证、req_params及音频流协议 | 云端也需要provider适配层；不能在管理解耦时擅自迁移旧AppID/AccessKey配置 |

Node24文档同时经Context7核对。上述latest/main链接会变化，实际接入时应按所选引擎版本和账号资源再核对。

## 当前实现和后续配置

现有`src/voice-tts.js`面向voxd包装协议：`POST /v1/speak/file`输入文字/音色，返回WAV字节与可选时长/缓存头；Host自检还读`GET /v1/health`。`src/voice-packs.js`保存包目录、安装进度与云端参数，独立于QQ消息泵。原Host仅代理3100，所以QQ停止时连管理页也失败。

采用Host直接承载共享管理模块：列表/配置/状态在QQ关闭时仍可用；概览和独立启停也迁入。旧QQ控制台复用该模块，保留原认证；QQ对外发送/语音库的准入仍由桥接负责。备选独立常驻管理服务虽可集中所有权，但新增端口、鉴权、进程监督和升级成本，当前收益不足。

后续选择本地时核对Mac架构、推理运行时、模型与音色许可、原生API及适配层；选择云端时核对认证代际、资源/音色、费用/额度、隐私及适配层。引擎选择不会改变本次独立管理入口。旧离线包有Windows/NVIDIA依赖，在Mac不应自动下载或尝试运行。
