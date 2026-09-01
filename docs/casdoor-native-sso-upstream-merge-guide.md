# Casdoor Native SSO：上游合并、补丁维护与 ACR 发布指南

> **适用基线：** Casdoor `v3.153.0`；生产分支为 `private-main`。本文记录的 Native SSO 功能源自 Casdoor PR #5438，并包含同应用直接登录、SAML2、组织选择页和深色模式的维护修复。[1] [2]

本文是 `DevHjz/Private-Casdoor` 的长期维护手册。它规定了分支职责、上游同步顺序、Native SSO 补丁组成、常见冲突的解决方法、功能验证步骤，以及阿里云 ACR 镜像的自动版本命名规则。所有上游同步都必须遵守本文的临时分支流程，**禁止直接在 `private-main` 拉取或合并上游代码**。

## 1. 分支模型与不可违反的规则

| 分支 | 职责 | 允许的变更 | 禁止事项 |
|---|---|---|---|
| `upstream-main` | Casdoor 官方上游的纯净镜像 | 仅快进或合并 `upstream/master` | Native SSO 私有补丁、部署工作流私有修改 |
| `patch-pr5438` | 可重复使用的 Native SSO 补丁源 | PR #5438 及其维护提交 | 直接吸收新上游主线 |
| `temp-adapt-patch` | 每次同步时的一次性适配分支 | 解决上游与补丁之间的冲突、运行验证 | 长期保留、直接部署 |
| `private-main` | 可部署的生产分支 | 仅合并已经适配并验证的临时分支 | 直接合并 `upstream/master` 或在此处解决上游冲突 |

这种结构将“获取上游”与“适配私有能力”分开。任何冲突都只能发生并解决在 `temp-adapt-patch`；这样，`private-main` 始终只接收一个已经审核完成的合并结果。

## 2. Native SSO 协议与信任边界

网页在登录页探测桌面伴侣程序的本机端口 `127.0.0.1:47321` 至 `47325`。桌面程序提供 `GET /native-sso/status` 和 `POST /native-sso/authorize`，并使用 RFC 8693 Token Exchange 取得只可用于 Native SSO 的访问令牌。网页随后调用 Casdoor 的 `POST /api/native-sso-complete` 来完成原本的登录、OAuth/OIDC 或 SAML2 响应。

| 阶段 | 责任方 | 必须保持的约束 |
|---|---|---|
| 本机发现 | `NativeSsoPanel.js` | 仅接受与当前 Casdoor `serverUrl` 一致的本机代理 |
| Token Exchange | Windows on ARM 桌面伴侣 | `grant_type` 必须是 Token Exchange；桌面端的 `device_secret` 仅在本机使用 |
| 完成登录 | `controllers/native_sso.go` | 令牌必须未过期、`GrantType` 必须是 Token Exchange，且令牌的组织/应用必须与网页目标应用一致 |
| 协议回调 | `LoginPage.js` | 登录、`code`、隐式令牌、设备授权和 SAML2 都必须按各自协议返回 |

跨组织的 `app-built-in` 场景如提示 `client_secret is required for native sso across organizations`，这是跨组织应用的安全校验，不应通过删除校验或在浏览器中暴露客户端密钥来绕过。

## 3. 本次维护补丁的完整行为

本仓库的增量补丁文件位于 [`docs/patches/casdoor-native-sso-maintenance-v3.153.0.patch`](patches/casdoor-native-sso-maintenance-v3.153.0.patch)。该文件可用于在已包含 PR #5438 的分支上复核或移植本次修复；它不是替代 PR #5438 的独立补丁。

| 问题 | 根因 | 修复位置 | 修复后的行为 |
|---|---|---|---|
| 同应用直接登录报 `unknown response type: undefined` | `/login` 没有 OAuth 查询参数；通用查询编码器把缺失值序列化成文本 `undefined` | `LoginPage.js` 与 `native_sso.go` | 前端明确发送 `responseType=login`；服务端兼容旧客户端的 `undefined`/`null` 并回退到 `login` |
| SAML2 Native SSO 不完整 | SAML URL 没有 OAuth `client_id`，且完成接口没有收到 `samlRequest`/`relayState` | `LoginPage.js`、`NativeSsoPanel.js`、`AuthBackend.js`、`native_sso.go` | 使用当前目标应用的 `clientId`；显式选择 `saml` 类型；完整生成并回传 SAML 响应 |
| 组织选择页展示二维码、设备登录或 Native SSO | Native SSO 和 Device Login 的渲染条件未排除 `orgChoiceMode` | `LoginPage.js` | `Select`/`Input` 组织选择态只显示组织选择控件，不显示任何设备登录入口 |
| 深色模式左右布局错误 | `.login-panel-dark` 缺少浅色容器的 `display: flex` | `App.less` | 深色主题下侧图、登录主面板和可选侧栏按左至右正确排列 |
| ACR 标签需要人工同步 | 工作流把版本写死在 YAML 常量中 | `.github/workflows/build.yml` | 根据当前提交可达的最近 Casdoor 发布标签自动生成镜像版本 |

### 3.1 服务端关键代码

`controllers/native_sso.go` 必须同时保留应用匹配检查、响应类型兼容回退和 SAML 字段映射。核心段落如下：

```go
responseType := c.Ctx.Input.Query("responseType")
// Older web companions could serialize an absent response type as the
// literal string "undefined". Treat absent values as the normal direct
// login flow while keeping other unexpected response types visible to the
// standard authorization handler.
if responseType == "" || responseType == "undefined" || responseType == "null" {
    responseType = ResponseTypeLogin
}
authForm := form.AuthForm{
    Type:         responseType,
    SigninMethod: "Native SSO",
    SamlRequest:  c.Ctx.Input.Query("samlRequest"),
    RelayState:   c.Ctx.Input.Query("relayState"),
}
resp := c.HandleLoggedIn(application, user, &authForm)
```

不要弱化此前的应用绑定检查：

```go
if application == nil || application.Owner != token.Owner || application.Name != token.Application {
    c.ResponseError(c.T("auth:The application does not match the native SSO token"))
    return
}
```

该校验是防止一个应用换取的 Native SSO 令牌被另一个应用消费的关键边界。

### 3.2 前端关键代码

直接访问 `/login` 时，`Util.getOAuthGetParameters()` 返回 `null`。因此必须在**调用** `completeNativeSso()` 之前决定协议类型；只在成功回调中才写默认值为时已晚。

```js
const oAuthParams = Util.getOAuthGetParameters() || {};
const responseType = oAuthParams.responseType || (oAuthParams.samlRequest ? "saml" : "login");
const nativeSsoParams = {
  ...oAuthParams,
  clientId: this.props.application?.clientId || oAuthParams.clientId || "",
  responseType: responseType,
  type: oAuthParams.type || responseType,
};
AuthBackend.completeNativeSso(accessToken, nativeSsoParams);
```

SAML2 需要将 `samlRequest` 和 `relayState` 附加到 Native SSO 完成请求：

```js
function nativeSsoParamsToQuery(params) {
  const query = oAuthParamsToQuery(params);
  const samlRequestQuery = params?.samlRequest ? `&samlRequest=${encodeURIComponent(params.samlRequest)}` : "";
  const relayStateQuery = params?.relayState ? `&relayState=${encodeURIComponent(params.relayState)}` : "";
  return `${query}${samlRequestQuery}${relayStateQuery}`;
}
```

对于组织选择页，Native SSO 与设备登录都必须使用相同的排除条件：

```js
!this.isOrganizationChoiceBoxVisible(application?.orgChoiceMode)
```

## 4. 下次合并 Casdoor 上游的标准操作

开始前必须确保工作区没有未提交的修改。若确有本地实验，请先审阅并保存，而不是把未确认代码带入同步流程。

```bash
git status --short
git fetch origin --prune
git remote add upstream https://github.com/casdoor/casdoor.git 2>/dev/null || true
git fetch upstream --tags
```

第一步只更新纯净上游基线：

```bash
git switch upstream-main
git merge --ff-only upstream/master || git merge upstream/master
git push origin upstream-main
```

第二步从新的纯净基线创建临时适配分支，并在此处分解和处理冲突：

```bash
git switch -c temp-adapt-patch upstream-main
git merge patch-pr5438
# 仅在这里处理冲突：编辑后执行
git add controllers/native_sso.go object/token.go web/src/auth/LoginPage.js
git commit
```

第三步将本次维护补丁恢复到临时分支。应优先使用已经审查过的提交；如需按文件移植，可应用仓库内补丁：

```bash
# 以实际维护提交哈希为准；不要在 private-main 上直接处理冲突
git cherry-pick <native-sso-maintenance-commit>
# 或者，在 patch 已确认与当前上游兼容时：
git apply --3way docs/patches/casdoor-native-sso-maintenance-v3.153.0.patch
```

第四步运行第 6 节的验证。验证通过后，才允许生产分支合并并清理一次性分支：

```bash
git switch private-main
git merge --no-ff temp-adapt-patch -m "chore: sync Casdoor upstream and Native SSO patch"
git push origin private-main
git branch -D temp-adapt-patch
```

> 如果合并失败，保留 `temp-adapt-patch` 以便继续排障；**不要**尝试把 `upstream/master` 直接合入 `private-main` 作为捷径。

## 5. 冲突处理与补丁更新

`web/src/auth/LoginPage.js` 是最常见的冲突文件。解决时不要按文本机械选择“ours”或“theirs”；应先核对下表中的不变量。

| 文件 | 必须保留的逻辑 | 审查方法 |
|---|---|---|
| `web/src/auth/LoginPage.js` | 直接登录默认 `login`、SAML 默认 `saml`、应用 `clientId` 优先、组织选择态隐藏设备入口、SAML 回调分支 | 搜索 `handleNativeSsoSuccess`、`shouldRenderNativeSso`、`renderDeviceLoginSidePanel` |
| `web/src/auth/NativeSsoPanel.js` | 向桌面端传递 `saml` 或明确的 OAuth/登录 response type | 搜索 `getNativeSsoRequestContext` |
| `web/src/auth/AuthBackend.js` | `completeNativeSso()` 必须携带 SAML 请求和 RelayState | 搜索 `nativeSsoParamsToQuery` |
| `controllers/native_sso.go` | Token Exchange、应用绑定、过期校验、`undefined` 兼容回退、SAML 表单字段 | 搜索 `NativeSsoComplete` |
| `web/src/App.less` | `.login-panel-dark` 与 `.login-panel` 都有 `display: flex` | 深色主题宽屏手工检查 |
| `.github/workflows/build.yml` | 保留手动触发与自动标签解析；不要把版本重新写死 | 本地执行第 5.1 节命令 |

冲突解决后应生成新的长期补丁，而不是依赖工作区中未跟踪的修改：

```bash
mkdir -p docs/patches
git diff --binary upstream-main...HEAD -- \
  controllers/native_sso.go \
  web/src/auth/LoginPage.js \
  web/src/auth/NativeSsoPanel.js \
  web/src/auth/AuthBackend.js \
  web/src/App.less \
  > docs/patches/casdoor-native-sso-maintenance-<upstream-tag>.patch
git add docs/patches
git commit -m "docs: refresh Native SSO maintenance patch"
```

## 5.1 ACR 镜像版本自动规则

工作流不再维护固定的 `CUSTOM_VERSION`。它会抓取 Casdoor 的发布标签，并选取当前 `HEAD` 可达的最近标签：

| Casdoor 上游标签 | 自动生成的 ACR 标签 |
|---|---|
| `v3.153.0` | `v0.3.153.0` |
| `v3.154.2` | `v0.3.154.2` |

本地复核命令如下。它必须对当前 `private-main` 的同步结果给出预期版本；例如当前基线应输出 `v3.153.0` 与 `v0.3.153.0`。

```bash
git fetch --force --tags https://github.com/casdoor/casdoor.git '+refs/tags/v*:refs/tags/v*'
RELEASE_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)"
IFS='.' read -r UPSTREAM_MAJOR UPSTREAM_MINOR UPSTREAM_PATCH <<< "${RELEASE_TAG#v}"
printf 'v0.%s.%s.%s\n' "$UPSTREAM_MAJOR" "$UPSTREAM_MINOR" "$UPSTREAM_PATCH"
```

### 完整 ACR 工作流

```yaml
name: 手动构建镜像到阿里云ACR

# 仅手动点击触发；镜像版本会根据当前提交包含的最近 Casdoor 发布标签自动计算。
on:
  workflow_dispatch:

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: 拉取代码及历史标签
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: 自动解析 Casdoor 镜像版本
        shell: bash
        run: |
          set -euo pipefail
          git fetch --force --tags https://github.com/casdoor/casdoor.git '+refs/tags/v*:refs/tags/v*'
          RELEASE_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)"
          IFS='.' read -r UPSTREAM_MAJOR UPSTREAM_MINOR UPSTREAM_PATCH <<< "${RELEASE_TAG#v}"
          if [[ -z "${UPSTREAM_MAJOR}" || -z "${UPSTREAM_MINOR}" || -z "${UPSTREAM_PATCH}" ]]; then
            echo "无法解析 Casdoor 上游版本标签：${RELEASE_TAG}" >&2
            exit 1
          fi
          CUSTOM_VERSION="v0.${UPSTREAM_MAJOR}.${UPSTREAM_MINOR}.${UPSTREAM_PATCH}"
          echo "CUSTOM_VERSION=${CUSTOM_VERSION}" >> "$GITHUB_ENV"
          echo "将构建 Casdoor ${RELEASE_TAG} 对应镜像：${CUSTOM_VERSION}"

      - name: 临时跳过测试（仅构建使用）
        run: |
          sed -i '22s/^/#/' Dockerfile

      - name: 登录阿里云镜像仓库
        uses: docker/login-action@v3
        with:
          registry: ${{ secrets.ALIYUN_CR_REGISTRY }}
          username: ${{ secrets.ALIYUN_CR_USERNAME }}
          password: ${{ secrets.ALIYUN_CR_PASSWORD }}

      - name: 构建并推送标准镜像
        uses: docker/build-push-action@v5
        with:
          context: .
          target: STANDARD
          push: true
          platforms: linux/amd64
          tags: |
            ${{ secrets.ALIYUN_CR_REGISTRY }}/${{ secrets.ALIYUN_CR_REPO }}:${{ env.CUSTOM_VERSION }}
            ${{ secrets.ALIYUN_CR_REGISTRY }}/${{ secrets.ALIYUN_CR_REPO }}:latest
```

## 6. 发布前验证清单

| 验证项 | 操作 | 预期结果 |
|---|---|---|
| Go 格式与服务端编译 | `gofmt -w controllers/native_sso.go && go test ./controllers` | 成功，或明确记录外部依赖下载问题后重试 |
| 前端生产构建 | 在 `web/` 执行 `yarn install --immutable`、`yarn build` | 无 ESLint/编译错误 |
| 同应用直接登录 | 让网页目标应用与 Windows 伴侣应用都为 `Cloud` | 点击 Native SSO 后成功登录；不出现 `unknown response type: undefined` |
| OAuth/OIDC 回调 | 使用 `code`、`token`、`id_token` 流程各一次 | 回调参数、`state` 与重定向正确 |
| SAML2 | 从 SAML SP 发起登录并选择 Native SSO | 正常发送 SAMLResponse 与 RelayState |
| 组织选择 | 访问 `orgChoiceMode=Select` 与 `Input` | 仅显示组织选择，不显示二维码、设备登录或 Native SSO |
| 深色主题 | 以宽屏打开含侧图/侧栏的登录页 | 容器按左至右显示，未堆叠 |
| ACR 版本解析 | 执行第 5.1 节命令 | 标签与本次上游版本相符 |

## 7. 回滚

部署异常时，先定位已知可用提交，再对生产分支回退。此命令会重写远程历史，只应由获得仓库维护授权的人员在确认影响后执行。

```bash
git switch private-main
git log --oneline --decorate -20
git reset --hard <known-good-commit>
git push --force-with-lease origin private-main
```

回滚后应重新在修复分支中分析问题，仍然通过 `temp-adapt-patch` 进入生产分支。

## References

[1]: https://github.com/casdoor/casdoor/pull/5438 "Casdoor PR #5438"
[2]: https://github.com/casdoor/casdoor/releases/tag/v3.153.0 "Casdoor v3.153.0 release"
[3]: https://www.rfc-editor.org/rfc/rfc8693 "RFC 8693: OAuth 2.0 Token Exchange"
