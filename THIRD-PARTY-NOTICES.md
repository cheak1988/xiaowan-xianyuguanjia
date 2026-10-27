# 第三方开源组件与参考项目声明

小丸闲鱼管家（以下简称"本软件"）是一个本地运行的桌面客户端。**本软件不是原创开发的产品**，
它由社区开源项目与公开技术方案整合而成，本项目负责整合、封装与界面适配。

本文件随程序一起分发。若你获取到的是解压目录版本，本文件位于程序根目录；安装版位于安装目录下。

---

## 0. 参考的开源项目（功能设计来源）

本项目在功能清单与模块划分上参考了以下社区开源项目。**未直接复制其源代码**，
而是在不同技术路线上重新实现。

### Ydisks-Xianyu-Helper

- 项目地址：https://github.com/Christ9038/Ydisks-Xianyu-Helper
- 参考范围：功能清单与交互设计，包括多账号管理、凭证续期、即时消息、自动化中心、卡密库存、
  商品管理、发货模板、订单管理、AI 回复、数据看板、通知告警、待发货兜底扫描等模块的划分方式。
- 实现差异：该项目后端为 Go + MTOP 私有签名接口，浏览器仅负责指纹与登录环节；本项目未使用其代码，
  采用 Electron 壳 + 闲鱼官方网页注入的独立实现，不调用平台私有接口、不使用其签名算法。

### 其他公开技术方案

技术选型与实现细节上还参考了公开的开源技术文档与社区讨论，包括 Electron 多分区会话隔离、
CDP 文件上传、DOM 注入与页面状态探测等公开做法。这些属于公开技术知识，不逐一列举。

如相关项目作者认为标注方式不妥，或认为存在未标注的参考，欢迎通过项目仓库 Issue 联系，我们会核实并修正。

---

## 1. Electron

- 版本：22.3.27
- 用途：桌面应用运行时（窗口、Chromium 渲染引擎、Node.js 环境）
- 许可证：MIT License
- 版权：Copyright (c) Electron contributors；Copyright (c) 2013-2020 GitHub Inc.
- 项目地址：https://github.com/electron/electron

本软件附带 Electron 的完整许可证文本：`LICENSE.electron.txt`，
以及其内嵌 Chromium 等组件的许可证汇总：`LICENSES.chromium.html`。

---

## 2. Semi Design（@douyinfe/semi-theme-default、@douyinfe/semi-icons）

- 版本：2.104.0
- 用途：界面的设计变量（颜色、间距、圆角等主题令牌）与静态 SVG 图标
- 许可证：MIT License
- 版权：Copyright (c) 2021 DouyinFE
- 项目地址：https://github.com/DouyinFE/semi-design

**使用范围说明**：本项目只使用了 Semi Design 发布的主题 CSS 变量与 SVG 图标静态资源，
**没有引入 React 运行时，也没有使用 Semi 的 React 组件实现**。界面 DOM 由本项目自行编写。
相关资源位于 `src/shell/vendor/semi/`，随程序离线分发，运行时不请求任何 CDN。

原始许可证文本见：
- `src/shell/vendor/semi/LICENSE-theme.txt`
- `src/shell/vendor/semi/LICENSE-icons.txt`
- 资源来源与校验值见 `src/shell/vendor/semi/NOTICE.md`

---

## 3. 构建期工具（不随程序分发）

以下工具仅在构建/打包阶段使用，不会作为代码分发给最终用户：

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| electron-builder | 24.13.3 | MIT | 生成 Windows 安装包 |
| cross-env | 7.0.3 | MIT | 跨平台设置环境变量 |
| Node.js | 构建环境自带 | MIT | 构建脚本运行环境 |

---

## 4. 未使用的常见组件（澄清）

为避免误解，特别说明本软件**没有**使用以下常被同类工具引入的组件：

- 没有引入 React / Vue / Angular 等前端框架运行时
- 没有引入 jQuery、Lodash 等通用工具库
- 没有引入 ECharts、Chart.js 等图表库（数据看板图表为项目自行用 Canvas 绘制）
- 没有引入 SQLite / better-sqlite3 等原生数据库（存储为项目自写的分文件 JSON）
- 没有引入任何闭源 SDK

---

## 5. 商标与平台声明

本软件为独立开发的第三方工具，与闲鱼、淘宝、阿里巴巴集团及其关联公司没有任何隶属、合作或授权关系。

"闲鱼""淘宝""阿里巴巴"等名称与标识为其各自权利人的商标或注册商标。本软件仅在描述用途时
以叙述方式提及这些名称，不表示任何形式的关联、认可或背书。

本软件不包含、不调用、不分发上述平台的任何私有接口、签名算法或加密密钥。

---

## 6. 许可证合规说明

- Electron 与 Semi Design 均为 MIT 许可证，允许商业与非商业使用、修改与再分发，
  前提是保留原版权声明与许可证文本。本文件及上述许可证文件即为此目的而保留。
- MIT 许可证要求的分发义务已满足：版权声明、许可条款随程序一同分发。
- 本软件自身代码的许可方式由项目作者另行决定。

---

## 7. 权利主张

- 项目官网：https://xianyuguanjia.com
- 完整声明：https://xianyuguanjia.com/legal.html

如你认为本软件的某个部分侵犯了你的权利，或认为对某个开源项目的参考标注不准确、不完整，
请通过项目仓库的 Issue 提出，并附上权属证明与具体页面或代码位置，我们会及时核实并处理。

---

最后更新：2026-10-27
