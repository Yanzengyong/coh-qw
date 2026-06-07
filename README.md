# COH Bundled Clearance 监听器

这个工具会定时检查 `https://cohcigars.com/cigars-bundle-clearance`，记录商品快照，并在发现上架、下架或价格变化时推送到企业微信。

## 1. 准备配置

复制配置模板：

```bash
cp .env.example .env
```

打开 `.env`，至少填写：

```env
COH_COUNTRY=China
CHECK_INTERVAL_SECONDS=60
PUSH_PROVIDER=wecom
WECOM_BOT_WEBHOOK=你的企业微信群机器人 webhook
```

企业微信 webhook 获取方式：

1. 打开企业微信群
2. 右上角群设置
3. 添加群机器人
4. 创建机器人后复制 webhook 地址
5. 粘贴到 `.env` 的 `WECOM_BOT_WEBHOOK`

也可以把 `PUSH_PROVIDER` 改成：

- `pushplus`：填写 `PUSHPLUS_TOKEN`
- `serverchan`：填写 `SERVERCHAN_SENDKEY`
- `webhook`：填写通用 `WEBHOOK_URL`
- `console`：只在终端打印，不推送

## 2. 测试推送

```bash
npm run notify:test
```

微信收到测试消息后，再做一次网页检查：

```bash
npm run check
```

第一次运行只会保存当前快照，不会把所有商品都当成“新上架”。如果你想第一次也推送当前列表，把 `.env` 里的 `FIRST_RUN_NOTIFY` 改成 `true`。

## 3. 长期运行

```bash
npm start
```

工具会按 `CHECK_INTERVAL_SECONDS` 持续检查。上架、下架、价格变化会推送商品名、价格和链接。

## 4. 后台运行建议

本地电脑可以用 `pm2`：

```bash
npm install -g pm2
pm2 start npm --name coh-clearance-monitor -- start
pm2 save
```

查看日志：

```bash
pm2 logs coh-clearance-monitor
```

停止：

```bash
pm2 stop coh-clearance-monitor
```

## 5. 数据文件

- `data/coh-clearance-state.json`：上一次商品快照
- `data/last-empty-page.html`：如果解析不到商品，会保存页面方便排查

如果网站改版导致解析失败，把 `data/last-empty-page.html` 发出来就能调整解析规则。
