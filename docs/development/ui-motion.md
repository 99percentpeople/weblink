# 界面动效

使用 `motion` 的原生 JavaScript API，应用不加载 React。本地 Solid 封装位于 `apps/web/src/components/ui/motion.tsx`。

## 入场、更新与离场 {#entrance-updates-and-exit}

```tsx
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";

<AnimatePresence when={open()}>
  <Motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 8 }}
    transition={{ duration: 0.18, ease: "easeOut" }}
  >
    Panel content
  </Motion.div>
</AnimatePresence>;
```

`Motion.*` 支持 HTML 标签及其常规 Solid 属性、ref，支持以对象指定 `initial`、`animate`、`exit` 目标，以及 Motion 的 `transition` 选项。更新 `animate` 目标会从当前值打断上一段动画。`initial={false}` 跳过首次入场，并尊重系统减少动态效果的偏好。

对于必须在次级 document 中运行的 CSS 属性动画，例如画中画工具栏，使用 `native`。它通过 `motion/mini` 解析并启动 WAAPI 动画，无需等待打开方窗口的动画帧。使用 CSS `transform` 关键帧而非 `x`、`y` 等别名，并配合 duration/easing 过渡参数。

Solid 不提供 React 的子节点协调机制，因此 `AnimatePresence` 接受显式 `when`。不要在其内部放条件 `Show`：presence 必须保留同一子节点，直到所有注册的离场动画完成。离场中的 motion 宿主会变为 inert，并对辅助技术隐藏；重新打开会取消待执行的移除。这是小型本地 API，并非完整的 Motion for React 实现，不提供 variants、手势属性或 keyed-list presence。

多态 UI 组件可通过 `as={Motion.button}` 保留原有样式与行为。`conversations/chat-scroll-button.tsx` 在私聊与房间聊天中共用回到底部按钮，通过 presence 控制入场、离场，并在离场期间禁用按钮。

## 布局变化 {#layout-changes}

```tsx
import { Motion } from "@/components/ui/motion";
import {
  createMotionLayout,
  MotionLayout,
  layoutScroll,
} from "@/components/ui/motion-layout";

const layout = createMotionLayout();

<MotionLayout value={layout}>
  <Motion.article
    layout
    layoutId="camera"
    classList={{ expanded: expanded() }}
  >
    Camera view
  </Motion.article>
  <Motion.aside layout="height">
    <div use:layoutScroll ref={scroll.viewportRef}>
      Chat messages
    </div>
  </Motion.aside>
  <button
    onClick={() =>
      layout.transition(() => setExpanded((v) => !v))
    }
  >
    Toggle
  </button>
</MotionLayout>;
```

`MotionLayout` 不增加 DOM 包装层。Motion 元素和原生指令通过 ref 向最近布局组的 Solid 上下文注册，在所有者清理时取消注册。引擎测量已注册节点，不通过选择器或 `data-motion-*` 属性查找节点。布局组外的注册为空操作，因此共享聊天组件也能独立渲染。

`layout` 注册移动视图，不安装观察器，也不会自动监听所有 DOM 变化。`layoutId` 在不同宿主之间标识同一视图，在一个组的移动视图中必须唯一；省略时使用注册对象身份。各组相互独立，Home 与 PiP 可复用相同 ID，而不会操作对方的节点。Portal 移动保留注册，实际 DOM 包含关系决定当前由哪个已注册缩略图栏或面板承载视图。

`layout.transition(update)` 在同步状态更新前后测量布局，并使用 `motion/mini` 动画化 CSS transform 和 opacity。应标记实际移动的视图，不要同时标记其祖先与后代。需要同时使用 `animate` 变换与布局变换时，应分开宿主。Presence 直接提供离场状态；离场视图在所有者销毁前一直保留注册，因此中断离场时可复用当前可见帧。

对其他组件或窗口修改的共享 signal，使用 `const displayed = layout.value(source)` 并渲染 `displayed()`。它在微任务中合并变化，再通过布局事务提交。普通 effect 读取已经更新的 DOM，无法恢复旧布局。布局组测量不会使调用它的 effect 订阅已注册属性。

会议画布将舞台与 PiP 提示保留在重叠的 presence 层中以交叉淡入淡出，聊天仍挂载在画布外。提示的大尺寸内层宿主参与侧栏布局过渡，外层宿主负责 opacity，避免两种动画互相覆盖。内容组接受尺寸补偿，使文字与 SVG 保持比例。不要同时对整个画布和其中各视频块应用布局变换。

`createMotionLayout({ afterUpdate: () => stage.measure() })` 在状态更新之后、目标快照之前刷新应用自己负责的布局计算。会议在侧栏改变舞台宽度时使用它，不额外增加 ResizeObserver。可选的 `root: () => element` 会等待根元素存在后再启动动画，并为折叠容器提供备用尺寸；组成员始终通过注册确定。

以下角色可与普通 Solid ref 和多态 UI 组件组合使用：

| Motion 属性            | 原生元素指令                 | 行为                                       |
| ---------------------- | ---------------------------- | ------------------------------------------ |
| `layout` / `layoutId`  | —                            | 动画化视图的位置和尺寸。                   |
| `layout="height"`      | —                            | 动画化面板实际高度，保持文字与控件形状。   |
| `layoutScroll`         | `use:layoutScroll`           | 恢复因临时测量目标布局而被限制的滚动偏移。 |
| `layoutContainer`      | `use:layoutContainer`        | 让折叠宿主继续可绘制，并保留滚动偏移。     |
| `layoutSize="avatar"`  | `use:layoutSize={"avatar"}`  | 在插值子元素自身尺寸时补偿父级缩放。       |
| `layoutOverlay="name"` | `use:layoutOverlay={"name"}` | 插值浮层边距和可用宽度，同时保持文字尺寸。 |

例如可使用 `<Tabs as={Motion.aside} layout="height">` 和 `<ClientAvatar as={Motion.span} layoutSize="avatar">`，无需增加包装层。原生指令从 `components/ui/motion-layout` 导入，作用于原生 DOM 元素；组件使用 Motion 的多态属性。只转发 ref 的组件可在 provider 下自己的所有者范围内调用 `createMotionLayoutRef(() => options)`，再把回调与现有 ref 组合。

滚动角色仅在下一次滚动事件前撤销测量副作用，不强制跟随底部，也不会在动画完成时恢复旧偏移；阅读者意图仍由会话滚动控制器负责。

浮层补偿要求容器绝对定位，并通过左右 inset 拉伸。长标签在容器内做截断。不要在同一子元素上再使用 `layout` 或其他 transform 动画。`avatar`、`name` 等补偿 ID 只在所属视图内有效，可在不同视频块之间重复。

会议网格将观察到的尺寸变化也交给同一过渡处理。居中偏移使用同一个测量框，防止观察器提交新布局前，CSS 先按旧尺寸视频块重新居中。来源列表更新共用动画帧队列，视图与网格尺寸在一次事务内变化。首次测量和隐藏舞台直接更新；连续缩放从当前可见动画帧打断重算。显式过渡中的同步测量会消耗待处理的 resize 工作，避免同一尺寸触发第二次动画。

会议布局变化期间，各视图目标保持 16:9。在可见的 `layoutContainer` 内，列表更新让视图保留在文档流中，以保留滚动范围，并防止动画清理撤销用户滚动。跨宿主的视图会暂时脱离文档流，这些宿主必须保留分配到的尺寸。内部 `motion-layout-active` CSS 类仅在此类过渡中关闭缩略图栏裁剪，并在完成或清理时移除。折叠容器会保持可绘制，直到其内容完成离场。

缩略图栏拥有显式网格行，工具栏动画不会挤动它。缩略图栏使用普通横向滚动；滚动吸附会追随变换中的视频块，并在列表更新时反复调整偏移，因此不采用。会议保留原有的一个 ResizeObserver，并通过 Solid Portal 保留视频元素。
