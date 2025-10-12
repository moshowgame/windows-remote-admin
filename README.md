SpringBootRemotePowershellAdmin
---
基于 **SpringBoot 3** 的轻量级 Windows 服务器远程管理工具，无需数据库依赖，开箱即用。

核心功能包括：
- **PowerShell 白名单命令远程执行**（带审计日志）
- **10M 以内日志查看**（关键词搜索 / 高亮）
- **文件列表浏览 / 下载**

帮助开发者快速实现服务器远程维护。

Author： [Moshow 郑锴](https://zhengkai.blog.csdn.net/)

---

## 🌟 核心功能

| 功能模块 | 具体能力 | 适用场景 |
|---------|---------|---------|
| PowerShell 命令 | - 执行白名单命令（带操作审计日志）<br>- 支持编码选择、常用命令快速输入<br>- 命令执行防抖 | 远程执行服务器操作（如进程查看） |
| 文件夹操作 | **FolderExplorer**：自定义路径浏览，展示文件 / 文件夹的名称、大小、修改时间 | 查看服务器目录结构 |
| 日志查看 | **LogViewer**：日志文件匹配、内容搜索、关键词高亮、查询范围天数限制（<10M） | 远程排查服务器日志问题 |
| 文件操作 | - **TextViewer**：只读模式查看文本文件<br>- **ViewContent**：小文件内容快速预览<br>- **Download**：直接下载文件 | 查看配置文件、获取服务器文件 |


---

## 🛠️ 技术栈

- 核心框架：SpringBoot 3.3（如需 2.7.X 版本，可从项目 `SpringBoot2` 分支获取）
- Web 容器：Undertow（替代默认 Tomcat，轻量高性能）
- 前端组件：CodeMirror5（日志 / 文本编辑，解决 Ace 渲染性能问题）
- 运行环境：JDK 17（推荐微软 MSJDK17）
- 构建工具：Maven
- 支持系统：Windows Only（当前版本）

---

## 🚀 快速开始

### 1. 环境准备

- 安装 JDK 17，并配置 `JAVA_HOME` 环境变量
- Maven 国内用户建议配置阿里云镜像，在 `settings.xml` 中添加：

```xml
<mirror>
  <id>aliyunmaven</id>
  <mirrorOf>central</mirrorOf>
  <url>https://maven.aliyun.com/repository/public</url>
</mirror>
```

### 2. 项目构建与启动

```bash
git clone https://github.com/moshowgame/ServerRemoteExecution.git
cd ServerRemoteExecution
mvn clean compile
```

启动项目：找到 `src/main/java/[包路径]/Application.java`（如 `com/moshow/server/Application.java`），运行 main 方法即可。

### 3. 验证启动

访问地址：http://localhost:12306/sre/

成功响应：hello world - https://zhengkai.blog.csdn.net/

---

## 🔧 API 示例

### 1. 列出文件夹内容（FolderExplorer）

**POST** `http://localhost:12306/sre/list`

请求体：

```json
{
  "filePath": "D:\\Download\\",
  "userName": "admin"
}
```

返回体：

```json
[
  {
    "directory": false,
    "lastModified": "2025-03-02 20:45:53",
    "name": "removeYoudao.js",
    "path": "D:\\Download\\removeYoudao.js",
    "size": "0"
  }
]
```

### 2. 读取日志 / 预览文件（LogViewer/TextViewer）

**POST** `http://localhost:12306/sre/read`

请求体：

```json
{
  "filePath": "D:\\Download\\app.log",
  "userName": "admin"
}
```

返回体：直接返回文件内容（支持关键词高亮）

### 3. 下载文件（Download）

**POST** `http://localhost:12306/sre/download`

请求体：

```json
{
  "filePath": "D:\\Download\\report.zip",
  "userName": "admin"
}
```

响应：触发浏览器文件下载

### 4. 执行 PowerShell 命令（Command Execution）

**POST** `http://localhost:12306/sre/execute`

请求体：

```json
{
  "command": "Get-Process java",
  "userName": "admin"
}
```

返回体：

```
Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName
-------  ------    -----      -----     ------     --  -- -----------
1234       56     7890       12345      10.5    123  12 java
```

---

## 📸 功能预览

| 功能 | 截图文件 | 预览说明 |
|-----|---------|---------|
| 文件夹浏览 | img_folderExplorer.png | 支持自定义路径输入，展示文件类型、大小、修改时间 |
| 日志查看 | img_logViewer.png | 关键词搜索高亮，可限制查询天数，解决大日志检索效率问题 |
| PowerShell 执行 | img_shell.png | 支持常用命令快速选择、编码切换，执行按钮带防抖 |
| 文本查看 | img_textViewer.png | 只读模式浏览长文本，界面适配底部显示 |

> 注：请确保截图文件放置在项目根目录，或修改路径为实际存储位置（如 docs/img/xxx.png）

---

## 📝 版本更新记录
### 2025-10-12
- 优化Powershell执行逻辑，使用jPowershell并支持多行模式
- 鉴权改为token only，用户名和使用目的仅用于审计
- 审计能力提升，添加IP到审计日志
- 其他minor changes，易用性提升

### 2025-04-06
- 优化 FileExplorer：支持自定义路径，修复搜索框问题
- 优化 PowerShellExecutor：新增编码选择、常用命令快速输入
- 优化 LogViewer：新增查询范围天数限制，提升日志检索效率

### 2025-03-11
- LogViewer：优化样式，替换编辑器为 CodeMirror5
- FileExplorer：文本浏览区域下移至底部，长文本阅读更友好

### 2025-03-10
- 修复 Shell 界面命令 API 路径错误
- 修复 "上下键调用历史命令" 失效问题
- 新增 logback 审计日志配置

### 2025-03-09
- 新增 LogViewer 功能

### 2025-03-03
- 新增登录页面、Landing Page

### 2025-03-02
- 初始化版本（支持基础文件浏览、PowerShell 命令执行）

---

## 📄 许可证

本项目基于 Apache-2.0 License 开源，详见项目根目录 LICENSE 文件。

---

## ❓ 常见问题

**Q：为什么日志查看限制 <10M？**
A：为避免大文件加载导致内存溢出，如需支持更大日志，可自行修改 LogViewer 模块的文件大小校验逻辑（搜索关键词 `fileSize < 10 * 1024 * 1024` 调整阈值）。

**Q：如何配置 PowerShell 命令白名单？**
A：在 application.yml 中添加：

```yaml
sre:
  powershell:
    whitelist: Get-Process,Get-Item,Get-ChildItem
```

**Q：审计日志如何查看？**
A：项目无 DB 依赖，审计日志默认输出到 `logs/sre-audit.log`，可通过 logback.xml 中的 sre-audit logger 调整。

**Q：能否支持 Linux 服务器？**
A：当前版本仅支持 Windows（依赖 PowerShell 环境），后续计划扩展 Linux Bash 支持，可关注 develop 分支。