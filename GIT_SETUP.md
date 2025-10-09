# Git 配置说明

## ✅ 已配置的 .gitignore

`.gitignore` 文件已创建，包含以下类别的忽略项：

### 📦 依赖和包管理

- `node_modules/` - npm/pnpm 依赖
- `bun.lockb` - Bun 锁文件
- `.pnp/` - Yarn PnP

### 📝 日志和输出文件

- `*.log` - 所有日志文件
- `*_backtest.log` - 回测日志
- `*_results.json` - 测试结果
- `baseline*.json/log` - 基准测试结果
- `enhanced*.json/log` - 增强版测试结果

### 💻 IDE 和编辑器

- `.vscode/` - VS Code 配置（保留部分有用配置）
- `.idea/` - JetBrains IDE
- `.DS_Store` - macOS 文件

### 🔧 构建和临时文件

- `dist/`, `build/` - 编译输出
- `*.tmp`, `*.temp` - 临时文件
- `.cache/` - 缓存文件

### 🔐 环境变量

- `.env*` - 所有环境变量文件

## 📋 当前项目中被忽略的文件

以下文件会被 Git 忽略：

```
logs:
├── latest_adaptive_backtest.log
├── latest_three_band.log
├── latest_three_band_0821_0910.log
├── latest_three_band_0821_0910_highcost.log
├── latest_three_band_0821_0910_highcost_guarded.log
├── rerun_three_band.log
├── simple_rebalance_backtest.log
├── three_band_rebalancer_backtest.log
└── baseline_three_band.log (如果存在)

dependencies:
└── node_modules/

IDE files:
└── .DS_Store
```

## ⚙️ 可选配置

如果您**不想追踪大型数据文件**，请编辑 `.gitignore` 并取消注释：

```bash
# 编辑 .gitignore
nano .gitignore

# 找到并取消注释这些行：
# dumps/*.json
# *.json
```

## 🚀 初始化 Git（如果还没有）

```bash
# 初始化 Git 仓库
git init

# 添加所有文件
git add .

# 查看将被提交的文件
git status

# 创建初始提交
git commit -m "Initial commit: Three-Band Strategy with tested baseline configuration"
```

## 📦 推荐提交的文件

### ✅ 应该提交

- `src/` - 所有源代码
- `tests/` - 测试文件
- `*.md` - 文档文件
- `package.json` - 项目配置
- `tsconfig.json` - TypeScript 配置
- `backtest.sh` - 回测脚本
- `THREE_BAND_STRATEGY_GUIDE.md` - 策略指南

### ❌ 不应该提交

- `*.log` - 日志文件（太大，且因人而异）
- `node_modules/` - 依赖（可重新安装）
- `*_results.json` - 测试结果（可重新生成）
- `.DS_Store` - 操作系统文件

### ⚠️ 可选（根据需求）

- `dumps/*.json` - 池子快照数据
  - 如果数据很大（>100MB）→ 不提交，使用 Git LFS 或外部存储
  - 如果数据较小且重要 → 可以提交
- `latest_adaptive_backtest.json` - 最新结果
  - 可以提交一个作为参考
  - 但不需要提交所有历史结果

## 🔍 检查当前状态

```bash
# 查看哪些文件会被追踪
git status

# 查看哪些文件被忽略
git status --ignored

# 查看 .gitignore 是否正常工作
git check-ignore -v <文件名>
```

## 📝 示例 Git 工作流

```bash
# 1. 查看当前状态
git status

# 2. 添加特定文件或所有修改
git add src/
git add THREE_BAND_STRATEGY_GUIDE.md
# 或者
git add .

# 3. 提交
git commit -m "Update strategy configuration based on testing results"

# 4. 推送到远程（如果已设置）
git push origin main
```

## 🌲 建议的分支策略

```bash
# 主分支：稳定的、经过测试的版本
main (或 master)

# 开发分支：日常开发
git checkout -b develop

# 功能分支：新功能测试
git checkout -b feature/test-new-parameters
git checkout -b feature/optimize-slippage

# 实验分支：激进的实验
git checkout -b experiment/predictive-rotation-v2
```

## 🎯 快速设置

```bash
# 完整设置步骤
git init
git add .
git commit -m "feat: Three-Band Strategy baseline (0.791% return, 0.012% drawdown)"

# 如果有远程仓库
git remote add origin <your-repo-url>
git push -u origin main
```

## 💡 提示

1. **日志文件已被忽略** - 不会占用 Git 空间
2. **文档会被追踪** - 策略指南和分析报告
3. **配置文件会被追踪** - 可以版本控制参数变化
4. **大型数据文件** - 根据需要决定是否追踪

---

**现在您可以开始使用 Git 了！** 🚀
