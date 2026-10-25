# 服务端部署（Render 免费实例）

前端仍在 GitHub Pages，服务端是独立的 WebSocket 服务（真正的「虚拟房主」）。
服务端零第三方依赖，只用 Node 内置模块，不需要数据库。

## 1. 部署服务端

1. 打开 https://dashboard.render.com ，用 GitHub 账号登录。
2. New → Web Service → 选择仓库 `delxiexiaojun/niuniu-deploy`（`tools/deploy.ps1` 已把 `package.json`、`render.yaml`、`server/` 一起上传）。
3. 填写：
   - Language：Node
   - Build Command：`npm install --omit=dev`
   - Start Command：`node server/index.js`
   - Health Check Path：`/health`
   - Instance Type：Free
4. 创建后等待首次构建完成，访问 `https://<服务名>.onrender.com/health`，返回 `ok` 即成功。

也可以在 Render 里直接 New → Blueprint，选择仓库自动读取 `render.yaml`。

## 2. 让前端连上服务端

拿到 Render 分配的地址后，二选一：

- 推荐：把 `js/net.js` 里的常量改成实际的 wss 地址，再重新执行 `tools/deploy.ps1`：
  ```js
  const DEFAULT_SERVER = 'wss://<服务名>.onrender.com';
  ```
- 临时验证：打开前端页面时带参数 `?server=wss://<服务名>.onrender.com`，地址会存进 localStorage，之后不再需要带参数。

本地开发时前端若通过 `localhost` / `127.0.0.1` 打开，会自动连 `ws://localhost:8787`；
在有 Node 的机器上执行 `node server/index.js` 即可本地起服务。

## 3. 免费实例的固有代价

- 闲置约 15 分钟会休眠，首次进房需要等实例冷启动（前端会提示「正在唤醒服务器，约需 30–60 秒」）。
- 实例重启后所有房间清空，进行中的对局会中断。
- 需要 7×24 常驻或更高并发时，升级为付费实例即可，代码无需改动。

## 4. 验证清单

- 两个浏览器标签同一房间：一个创建、一个用房间号/分享链接加入，准备后自动开局。
- 创建者直接关闭标签页：另一人仍在房间内，可继续准备开局。
- 创建房间后 10 分钟内无人开局：所有人收到「房间已自动关闭」。
- 断网/锁屏后再回来：自动用 token 回到原座位。
