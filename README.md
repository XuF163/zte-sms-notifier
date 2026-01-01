# ZTE 路由器短信通知扩展（zte-sms-notifier）

Chrome 扩展：轮询读取 ZTE 路由器 WebUI（`/goform/*`）的未读短信，并通过系统通知提醒。

## 功能

- 自动轮询检查未读短信数量
- 新短信系统通知（点击通知可打开路由器短信页）
- 可在 Popup 一键开始/停止轮询、立即检查、重置已通知记录
- 选项页支持测试连接与参数配置

## 文件结构

```text
zte-sms-notifier/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── popup.css
├── options.html
├── options.js
├── options.css
├── icon16.png
├── icon48.png
└── icon128.png
```

## 安装（开发者模式）

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `zte-sms-notifier` 文件夹

## 使用

1. 点击扩展图标打开 Popup
2. 点击「⚙️ 设置」进入选项页
3. 配置：
   - 路由器地址（默认 `http://192.168.0.1`）
   - 设备密码（用于登录路由器 WebUI）
   - 轮询间隔（秒）
4. 保存后可点击「测试连接」
5. 回到 Popup 点击「开始轮询」或「立即检查」

## 备注

- 轮询使用 `chrome.alarms`，最小间隔为 60 秒；低于 60 秒会被自动提升到 60 秒。
- `manifest.json` 目前仅声明了 `192.168.0.1` / `192.168.1.1` 两个地址的访问权限；如果你的路由器是其它地址，需要相应调整 `host_permissions`。

## 更新日志

### v1.0.0

- 初始版本：轮询 + 通知 + 选项页配置
