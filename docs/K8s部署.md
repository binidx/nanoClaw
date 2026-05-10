# K8s 部署

这份文档只覆盖当前仓库已经补好的容器化方案，目标场景是：

- 只启用 Repo Review 为主的使用方式
- SQLite 持久化
- 单副本运行
- Kubernetes 单 Deployment 部署

它不是多副本高可用方案。当前仓库的状态落在本地 SQLite 和项目目录下的持久化文件中，因此不适合直接做水平扩容。

## 结论先说

- 运行形态：`Deployment + 1 Pod + PVC + Ingress`
- 更新策略：`Recreate`
- 数据目录：`store/`、`groups/`、`data/`、`$HOME/.config/nanoclaw/`
- 探针：`/healthz`、`/readyz`
- 镜像入口：`node dist/index.js`

仓库里已经补好的文件：

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- `deploy/k8s/*`

## 为什么只能单副本

当前项目的关键状态不是外部数据库，而是本地文件和 SQLite：

- `store/messages.db`
- `groups/`
- `data/`
- `$HOME/.config/nanoclaw/`

对于 Repo Review，这些状态还会和本地仓库路径、hook 安装、运行记录、分支状态缓存一起工作。  
所以这套 K8s 方案明确按单副本设计：

- 不做 HPA
- 不做多副本
- 不做 RollingUpdate
- 用 `Recreate` 避免 SQLite/PVC 同时被旧新 Pod 抢占

## 构建镜像

镜像已经按 Linux 环境多阶段构建补好，包含：

- 后端 `dist/`
- 前端 `web/dist/`
- `agent/runner/dist/`
- `agent/skills/`
- `shared/`

构建示例：

```bash
docker build -t registry.example.com/nanoclaw:latest .
docker push registry.example.com/nanoclaw:latest
```

如果你们不用 Docker Engine，也可以用任意 OCI 构建器，只要最终产出同样的镜像即可。

## K8s 清单说明

目录：

```text
deploy/k8s/
  configmap.yaml
  deployment.yaml
  ingress.yaml
  kustomization.yaml
  namespace.yaml
  pvc.yaml
  service.yaml
```

默认设计：

- `Namespace`：`nanoclaw`
- `ConfigMap`：运行时基础环境变量
- `PVC`：`nanoclaw-data`
- `Deployment`：单副本 + `Recreate`
- `Service`：ClusterIP
- `Ingress`：`nanoclaw.example.com`

应用前至少改这几个地方：

1. `deploy/k8s/deployment.yaml` 里的镜像地址
2. `deploy/k8s/pvc.yaml` 里的 `storageClassName`
3. `deploy/k8s/ingress.yaml` 里的域名和 ingress class

应用：

```bash
kubectl apply -k deploy/k8s
kubectl rollout status deployment/nanoclaw -n nanoclaw
```

## 持久化目录

当前清单会把一个 PVC 通过 `subPath` 挂到这些位置：

- `/app/store`
- `/app/groups`
- `/app/data`
- `/app/logs`
- `/home/nanoclaw/.config/nanoclaw`

其中最关键的是：

- `store/messages.db`
- `data/uploads`
- `data/custom-skills`
- `data/mcp-servers`

如果 PVC 丢失，Repo Review 配置、Provider 配置、运行记录和 SQLite 数据都会一起丢。

## 健康检查

这次补了两个匿名探针端点：

- `/healthz`
- `/readyz`

原因是原来的 `/api/status` 和 `/api/doctor` 在默认配置下受 `/api` 登录保护，不能直接给 K8s 探针使用。

K8s 清单已经默认把它们接到：

- `startupProbe`
- `readinessProbe`
- `livenessProbe`

## Repo Review 仓库挂载

如果你只用“远端同步审查”或 webhook 驱动的远端分支审查，应用自己的数据 PVC 就够了。  
如果你要让 Repo Review 直接读取本地仓库，或者安装本地 hooks，就必须再给 Pod 挂一个稳定的仓库目录。

推荐把本地仓库统一挂到：

```text
/workspace/repos
```

然后在 Repo Review 配置里填写容器内可见路径，例如：

```text
/workspace/repos/my-project
```

对于 hook 安装场景，这个仓库挂载必须可写，因为它会修改：

```text
.git/hooks
```

`deploy/k8s/deployment.yaml` 里已经预留了注释位，你可以按自己的存储类型补一段额外挂载。示例：

```yaml
volumes:
  - name: review-repos
    persistentVolumeClaim:
      claimName: nanoclaw-review-repos

volumeMounts:
  - name: review-repos
    mountPath: /workspace/repos
```

## 首次启动要做什么

第一次启动时，最容易忽略的不是 Pod 是否启动，而是应用内部初始化和首登流程：

1. 看 Pod 是否 Ready
2. 查看日志里是否出现临时登录密码
3. 登录 Web 控制台
4. 配置默认 Provider
5. 再进入 Repo Review 配仓库、profile、hook 或 webhook

查看日志：

```bash
kubectl logs deployment/nanoclaw -n nanoclaw
```

如果数据库里还没有设置 `WEB_LOGIN_PASSWORD`，系统会在日志里打印一次临时密码。  
当前仓库的 Web 登录密码和 Provider 配置主要保存在 SQLite 里，不是靠普通环境变量注入。

这意味着：

- 首次登录凭据要从日志取
- 配置完后会持久化到 `store/messages.db`
- 后续重建 Pod 只要 PVC 还在，配置就还在

## 生产上需要额外确认的事

- `Ingress` 后是否正确透传 WebSocket
- 如果走 Git SSH clone，是否给容器挂了 SSH key 和 `known_hosts`
- 如果只做 HTTPS clone，容器是否能访问目标 Git 平台
- Repo Review 用到的本地仓库路径在容器内是否真实存在
- 是否真的只保留单副本，没有被平台自动扩成多个 Pod

## 推荐巡检命令

```bash
kubectl get pods -n nanoclaw
kubectl logs deployment/nanoclaw -n nanoclaw
kubectl exec -it deployment/nanoclaw -n nanoclaw -- sh
```

容器内最值得先检查的是：

```bash
ls -la /app/store
ls -la /app/groups
ls -la /app/data
ls -la /workspace/repos
```

## 这套方案的限制

- 只适合 SQLite 单副本
- 不适合 HPA
- 不适合多副本并发写入
- `WEB_LOGIN_PASSWORD` 这类配置当前不是标准环境变量驱动
- 如果 Repo Review 需要本地仓库，仓库卷必须由运维额外挂载

如果后面要做真正的多副本部署，先决条件不是改 K8s 清单，而是先把状态从本地 SQLite 和本地目录迁出。
