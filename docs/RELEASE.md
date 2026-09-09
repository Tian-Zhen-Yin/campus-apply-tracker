# 发布流程(维护者)

1. 改 `package.json` version 与 `CHANGELOG.md`,提交;
2. 打完整版发行包(需要本机 dev-local 台账路径,见 `src/dev-local.mjs`):
   - macOS:`scripts/pack-offline-full.sh <版本号>`
   - Windows:`scripts/pack-full-windows.sh <版本号>`
3. GitHub 建 Release,贴 `dist/` 下两个 zip;打 tag `v<版本号>`;
4. Gitee 只读镜像同步(push + 同步 Release 附件);
5. 发布前人工检查:`docs/guide-img/` 各截图是否含真实个人信息(需为演示数据)。

公开仓库历史为单初始提交起步(ADR-0005),私有开发历史备份在本地 `../ats-status-private-history.bundle`。
