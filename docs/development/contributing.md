# 参与贡献

Pull request 应以 `public` 分支为目标。除非已讨论破坏性变更，否则请保持现有协议和用户可见行为兼容。

## 配置工作区 {#workspace-setup}

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

前端位于 `apps/web`。在根目录安装一次，即通过根锁文件覆盖前端和两个服务端子模块。服务端锁文件保留给独立克隆使用，设置及更新流程见[工作区开发](workspace.md)。

## 必需检查 {#required-checks}

`CI / Checks` 使用 Bun 1.4.2，运行前端类型检查、单元测试和集成测试。标签发布还会校验 `apps/web/package.json` 中版本与标签及根 `CHANGELOG.md` 一致。

```sh
bun run lint
bun run test:unit
bun run test:integration
bun run build
```

独立 `Signaling servers` 工作流使用根工作区安装，检查固定提交的 Bun 服务和 Cloudflare Worker。更新子模块时运行相关检查，不要在 PR 工作流加入部署凭据。CI 必须继续支持来自 fork 的贡献。

## 代码变更 {#code-changes}

- 保持 TypeScript strict，使用根 Prettier 配置格式化修改文件。
- 为新行为及协议/状态机变化添加针对性测试。
- WebRTC 基础实现放在 `apps/web/src/libs/domain`，编排放在 `apps/web/src/libs/application`，具体适配器放在 infrastructure。
- 兼容性新增复用共享协议版本，破坏线格式的变更要求协调更新各端。
- 先在服务端自身仓库提交变更，再更新父仓库 gitlink。PR 不得包含尚未发布的子模块提交。
