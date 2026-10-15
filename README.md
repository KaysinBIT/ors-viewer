# ORS Viewer

独立的 ORSSession 解析与三维查看软件。支持体数据、分割标签、三角网格和测量表，全程在本机运行，无需安装 Dragonfly。

使用说明：[PDF 说明书](viewer/web/manual.pdf) · [网页版说明书源文件](viewer/web/manual.html)。运行软件后也可点击右上角“使用说明”，离线阅读全部操作步骤。

## 功能

- 导入 `.ORSSession`、`.ORSObject`、二进制/ASCII `.STL` 和三维/四维数值 `.NPY`。
- 自动提取支持的对象类型，保存原始记录、元数据、数值数组、网格和测量表。
- 原始网格默认保留全部顶点和三角面，不自动简化。手动调整保留比例后才简化，设回 100% 恢复原始网格，并显示实际面数。
- 体数据显示最大强度投影、等值面、三向切片和任意角度灰度切片，支持窗口与时间步调节。
- 分割标签着色、单标签局部显示、完整体素统计。
- 可调剖面方位角、仰角和距离，支持反向剖切、仅显示截面及沿法线的正交正视。
- 拖动剖面时同步更新三维画面，后台计算精确截线；正视模式移动剖面时保持缩放。
- 测量表分页、单位与缩放、CSV 下载、逐顶点标量着色。
- 三维旋转、平移、缩放、居中、线框、包围盒、截图及显示网格 PLY 导出。
- 后台导入任务、结果持久化、桌面启动窗口、命令行提取。

## Windows 免安装版

1. 从 Releases 下载 `ORSViewer-0.6.1-Windows-x64.zip`。
2. 完整解压，保持 `ORSViewer.exe` 与 `_internal` 目录在一起。
3. 双击 `ORSViewer.exe`，在打开的界面中点击“导入文件”。

发行包包含 Python 运行环境，不需要单独安装 Python 或 Dragonfly。三维界面需要支持 WebGL 2 的浏览器。大文件可直接输入本地路径，避免上传副本。

桌面窗口提供“打开三维界面”“打开数据目录”和“退出软件”。关闭启动窗口会停止服务；未完成任务的已有输出会保留。运行数据默认存放在系统用户数据目录的 `ORSViewer` 子目录，与软件安装目录分开。

## 从源码运行

需要 Python 3.14 或更新版本：

```sh
python -m venv .venv
# 激活虚拟环境后：
python -m pip install .
ors-viewer
```

仅启动本地服务：

```sh
ors-viewer --headless --open --port 8769
```

指定运行数据目录或打开已有解析结果：

```sh
ors-viewer --state-dir ./viewer-data --data ./extracted/data
```

命令行提取全部支持的对象：

```sh
ors-extract sample.ORSSession --output extracted
ors-extract sample.ORSObject --output extracted --dense-labels
```

输出目录必须不存在。省略 `--dense-labels` 时，分割优先保存为稀疏区间，避免大体积稠密数组。`--dense-limit-gib` 控制稠密标签输出上限。

## 数据与显示

| 数据 | 保存形式 | 查看功能 |
| --- | --- | --- |
| 体数据 | 原始位宽 NPY，TZYX | 投影、等值面、切片、窗口、时间步 |
| 分割 | 稀疏标签区间、可选稠密 NPY | 多标签表面、单标签显示、体素统计 |
| 网格 | 顶点、三角面、法线、UV、PLY | 完整网格、手动简化、线框、剖切 |
| 测量 | NPY/JSON 列、适用时 CSV | 分页、单位和缩放、标量映射 |
| 容器 | XML、原始记录、清单、哈希 | 完整性和未解释记录保留 |

原始网格的 100% 模式不丢弃、合并或去重三角面。浏览器坐标使用 float32；原始导出数组保留源精度。手动简化使用顶点聚类，目标比例可能与实际面数略有差异。大型完整网格需要相应的内存和显存，程序不会自动降低面数。

体数据与分割表面使用界面所选采样精度；体数据的显示纹理为 8 位。分割保留比例相对当前采样表面计算。网格剖面显示交线，不自动封口；体数据剖面显示采样灰度。显示网格 PLY 导出不写入显示用的剖切操作，也不包含测量表或标签属性。定量分析应使用原始数组和测量数据。

支持 ORSD、ORSZ 与 CAIFZ 的已实现容器结构。未支持的对象语义不作推测，原始记录保留供其他处理使用。软件不恢复完整 Dragonfly 工作区的全部渲染状态、历史操作或父节点关系。NPY 按 ZYX/TZYX 解释且默认体素间距为 1；STL 不包含物理单位。

## 本地运行

服务只监听 `127.0.0.1`。网页资源随软件提供，不依赖外部 CDN；导入文件不会上传到远程服务器。文件选择导入上限为 64 GiB，更大的文件使用本地路径导入。解析结果、缓存和运行日志保存在运行数据目录。

## 测试与构建

```sh
python -m unittest discover -s tests -v
node --test tests/test_section.mjs
python -m pip install -r requirements-build.txt
python scripts/build_windows.py
```

Windows 构建产生独立程序目录、ZIP 和 SHA-256 校验文件。源码安装可用于支持 Python 3.14 与 WebGL 2 的系统；随附的独立程序面向 Windows x64。

说明书内容位于 `docs/manual_content.json`。如需重新生成 HTML/PDF，安装 ReportLab 后运行 `python scripts/build_manual.py`；非 Windows 环境可通过 `--font` 和 `--font-bold` 指定支持中文的 TrueType 字体。

## 许可证

本项目使用 [MIT License](LICENSE)。第三方组件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。内置四面体为程序生成的示例，不包含用户数据。
