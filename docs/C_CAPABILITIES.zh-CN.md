# C 能力参考：图片、公开联网与引用

[中文](C_CAPABILITIES.zh-CN.md) | [English](C_CAPABILITIES.en.md)

这是一组可选、零第三方依赖的参考模块，用来保留“当前消息图片”和“公开联网回答”的可复用边界。它没有替 starter 接通模型、浏览器、图片解码器、Telegram 或云端网关。引入文件不会改变 `npm start`、模拟 demo、worker 或记忆处理；也不代表部署成功、真实联网成功或完整聊天体验已验收。

## 包含什么

- `src/capabilities.mjs`：当前消息的显式联网准入、图片元数据选择，以及必须提供可信完整解码器的图片封装验证。
- `src/web-sources.mjs`：固定会话/轮次的完成事件适配层、有界来源收集、服务端引用渲染，以及回答和来源元数据的一致性验证。
- 两组纯合成测试。测试中的图片解码器是明确的模拟函数；测试通过不证明真实 PNG/JPEG 解码或 provider 集成可用。

使用 Node 22 或更新版本，不用安装依赖：

```sh
node --test test/capabilities.test.mjs test/web-sources.test.mjs
npm run check
```

新测试只使用标准库与虚构输入。全仓检查还会运行已有的本地 HTTP 和恢复测试。此增量没有外部联网传输、模型调用、运行时安装器或云端命令。

## 当前消息准入

`admitWeb(text)` 返回 `{kind: 'query', query}`、`{kind: 'none'}` 或 `{kind: 'refused'}`。支持的例子包括 `/web public astronomy`、`search the web for public astronomy`、`联网搜索 公开天文知识`。规则锚定于当前单条消息，拒绝 CR/LF、空查询、超长输入和若干明显的凭据/私有上下文模式。

这只是保守启发式，无法识别所有私人信息。真正接入时，应用仍须独立判断是否获准向外部发送，不能给公开搜索附加私人聊天历史、记忆、身份资料、文件或隐藏上下文。不符合已支持表达的自然语言请求不会自动启用搜索。模型自述“能/不能联网”都不是运行证据；后续追问和话题连续性需要单独路由与验证。

## 图片适配器约束

`selectPhoto(variants)` 仅在当前消息的候选图片中选择符合条件、面积最大的一个；相同面积按文件 ID 排序。返回冻结的元数据副本，并丢弃未知字段。元数据不是下载授权，也不是图片验证结果。

限制：最多 100 个候选；宽高必须为正整数，单边不超过 2048，总像素不超过 4,194,304；若提供大小，最多 1 MiB。文件 ID 是有界不透明字符串，不是 URL 或本地路径。

`createImageValidator({decodeImage})` 必须接收应用自身提供的可信解码函数；缺失时直接拒绝。`validate(envelope, {signal, deadlineAt})` 只接受以下四个字段：

```js
{
  mime: 'image/png', // 或 image/jpeg
  base64: '<原始字节的规范 base64>',
  byteLength: 123, // 必须是实际正字节数，最大 1 MiB
  sha256: '<原始字节的小写 SHA-256>'
}
```

上面只是结构说明，不是有效图片。规范 base64、精确长度和哈希只能说明封装自洽，不能证明内容是图片。解码函数必须完整解码同一份字节、拒绝截断和不支持的格式特性、遵守传入的字节/像素/尺寸限制，并恰好返回 `{mime, width, height}`。仅检查文件头、或信任调用方自带的“已验证”对象都不够。外层还会检查返回类型和尺寸，并拒绝解码函数修改其字节副本。

解码函数属于可信应用代码，不能来自请求或模型。这里没有内置解码器，任何格式都必须实际调用该函数后才能通过。真实适配器还需要在下载/模型请求前检查权限，使用批准的固定传输目标，按策略拒绝重定向，限制流式下载字节，核对平台元数据与解码尺寸，并避免将凭据或文件 URL 写入日志。

每个 validator 实例最多一个解码进行中、一个排队，外层等待最长五秒。取消会尽快返回，但底层解码真正结束前不会释放正在使用的槽位；永不结束的解码会阻塞该实例。取消是协作式的，这不是进程/原生内存沙箱。真实接入应在每个 worker 内复用单例，并使用真正有界的解码器或隔离的解码进程。

## 完成事件、来源与引用

用服务端已知且非空的标识构造一个 `TurnWebSources({threadId, turnId})`。应用必须先验证 provider 传输身份和事件所属轮次，再传入本模块。下面是应用适配层约定，不是对任一 provider 原生协议的声明：

```js
import {TurnWebSources, validRenderedWebEvidence} from '../src/web-sources.mjs';

const sources = new TurnWebSources({threadId: 'synthetic-thread', turnId: 'synthetic-turn'});
sources.observeCompleted({
  threadId: 'synthetic-thread', turnId: 'synthetic-turn', status: 'completed',
  item: {
    id: 'synthetic-item', type: 'webSearch', action: 'search',
    results: [{type: 'text_result', ref_id: 'ref-a', url: 'https://example.com/', title: 'Synthetic source'}]
  }
});
const answer = sources.render('一条虚构说明 [[source:ref-a]]', 4096);
if (!validRenderedWebEvidence(answer.evidence, answer.text, 4096)) throw new Error('reject');
```

示例 import 适用于 `docs/` 内的模块；在其他位置运行需调整路径。所有值都是虚构 fixture，代码不发送请求。JSON 字段相同不等于来源可信，因为不可信调用方可以伪造它们。不要把 `observeCompleted` 直接作为对公网开放的 HTTP 接口。

每个完成项都会计算内容指纹；相同内容的重复项去重，同 ID 内容冲突、错误轮次、未完成事件、非法结构或超限会阻断该收集器。最多接受四个不同项，而且至少要有一个完成的 `search`；只有 `openPage`/`findInPage` 观察不算完成搜索。这些 action 名称只记录观察，不执行网络操作。

只解读扁平的 `text_result` 子集。额外字段在整体限界后丢弃；即使正文没引用某条记录，其缺失/非法来源元数据也会使完整性失败。限制保留为：64 个来源、32 次引用、32 KiB 的来源/引用序列化元数据、标题 256 个 Unicode 码点、URL 2048 字符。事件先限制为 64 KiB、深度 12、最多 16,000 个节点。

模型只写 `[[source:ref-a]]` 标记，不能自行填写最终 URL。服务端按首次出现顺序编号，附上已观察的来源 URL。未知引用、坏标记、预先编号的引用、模型直接写 URL 或保守识别出的裸链接都被拒绝。严格的 `HH:MM:SS` 时间文本可以保留，IPv6 地址和不符合该严格格式的类似时间字符串仍被拦截。保守 DNS 识别也可能拒绝普通的带点文件名，这是明确的 fail-closed 限制。

URL 检查只看语法：规范 HTTPS、类似公开 DNS 的域名，不接受 userinfo、自定义端口、明显凭据、IP 字面值或列出的本地后缀。它不解析 DNS，不防御 DNS 重绑定/重定向，不判断页面安全，不识别所有私人信息，也不证明网页支持回答中的结论。页脚明确说明结论支持关系未核实；标题只保留在元数据，不显示在引用页脚。

`validRenderedWebEvidence` 检查内部一致性、大小、引用绑定与精确页脚。它不能为序列化结果认证来源，也不能核实网页内容。应用各边界都应验证，但不能把这类一致性元数据当作认证 token 或运行证明。

## 接入与运维清单

1. 在获得授权并完成 provider、传输和解码适配器之前，保持能力关闭。部署值在源码之外配置；本参考模块不需要账号设置。
2. 只准入当前请求。图片区分于公开搜索轮次；图片文字或网页内容不能授权额外工具。
3. 在产生外部影响前及发送前检查权限；不要把模型自述当作路由判定。
4. 对完成事件先认证、绑定再限界。不认识的 provider 结果结构应拒绝，经过审查才能扩展；不能从模型正文补造引用。
5. 只保留必要诊断。使用固定拒绝码，不记录请求正文、图片字节、provider stderr、账号资料或带凭据的 URL。
6. 在实际目标中分别测试真实图片、受支持的显式联网命令、不支持的自然语言命令、追问、非法元数据、取消及重试不确定性；来源元数据和用户端实际收到的消息分别验收。
7. 任一层缺失或拒绝时，准确说明限制。传输可用、隔离检查通过或离线测试通过，不能改写成真实联网或用户聊天验收成功。
8. 这个可选参考模块尚未接入 starter；回退时移除自己的 imports/适配器即可，不改变已有状态格式或部署行为。

## 有意保留的抽取差异

公开切片使用 JavaScript 模块与标准库，新增输入类型/CRLF 检查、有界图片元数据副本、强制注入的解码接口、私有来源字段、固定轮次适配层、事件预算及输出长度参数验证。通用元数据版本改为 `public-web-results/v1`。核心准入表达、URL/引用 ID/标题谓词、引用映射、保守链接过滤、严格时间豁免和来源/引用预算保留。这里不包含私人配置、操作历史、运行回执、provider 实现或集成成功声明。
