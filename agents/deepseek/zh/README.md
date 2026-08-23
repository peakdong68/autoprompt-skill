# DeepSeek Harness 包

本包面向 DeepSeek Harness 0.1.0-rc.7。

- [`SKILL.md`](SKILL.md)：L0 调度提示词
- [`agents`](agents/)：25 个生成的角色定义
- [`frameworks`](frameworks/)：18 个任务与门禁工作流
- [`GATES.md`](GATES.md)、[`MODES.md`](MODES.md)、[`PLAYBOOKS.md`](PLAYBOOKS.md)：执行契约

Web 会话请选择 Autoprompt 代理预设。无头（headless）运行时，请通过 `--patch` 传入已安装的 `headless.patch.yml`。每个角色工具都会拒绝白名单之外的角色工具，并使用不超过四层的深度上限。

每个角色均继承所选的父模型。不支持自定义 `agents=` 模型路由。
