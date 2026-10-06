# iOS 独立 PWA 底部死区/多余 padding：完整踩坑记录与最终解法

> 来源：DSH PWA（iOS Safari + 添加到主屏幕的 standalone PWA）真实项目，横跨 v0.2.1 → v0.9.5 四次修复才根治。
> 给正在遇到同样问题的 coding agent：先看「最终解法」，再按需读「踩坑过程」避免重走弯路。

## 症状

- **主屏幕打开的 PWA（standalone 模式）底部有一段空白/死色带**（约 34–60pt），输入栏悬浮在半空、下面露出页面背景色；
- **同一页面在 Safari 里正常**，只有 standalone 有问题；
- 键盘弹起时表现各异：整页被顶上去留全屏空白、或输入框被键盘盖住。

## 根因（三个独立的问题叠加，所以修了很久）

### 问题 1：iOS standalone 的百分比高度布局视口算错（主犯）

`#app { height: 100% }` 里的 `100%` 解析到的是**布局视口（layout viewport）**。iOS 的 standalone PWA 在某些状态下（尤其首屏/恢复启动）会把布局视口算矮一截 → `100%` 拿到的高度 < 真实可视区域 → 应用整体浮起，底部露出死区（实测整 app 浮高约 60pt）。

- Safari 标签页模式没有这个误算 → 「Safari 正常、PWA 不正常」是它的指纹。
- `100dvh` 也不可靠：standalone 下 dvh 同样会 underfill。

### 问题 2：visualViewport 首屏读数不可靠（第一版修法的反噬）

第一版修法是「启动时无条件把 `#app` 高度钉成 `visualViewport.height` 像素值」。结果 iOS standalone **首帧的 vv 值偏小** → 整个布局被压短、composer/tab 栏下方出现大片黑边——比原 bug 更糟。这是经典的「用一个不可靠的信号去修另一个不可靠的信号」。

### 问题 3：home 指示条区域露出原始背景（视觉残留）

前两个修好后仍剩一条 ~34pt 的「死色带」：那是 iPhone home 指示条的安全区，底栏背景没有延伸进去，露出了 body 的背景色，看起来像多余的 padding。

## 最终解法（可直接抄）

### ① 根容器：`position:fixed; inset:0`（这是「突然搞定」的那一刀）

```css
#app {
  /* height:100% 在 iOS standalone 下解析到算错的布局视口 → 底部死区。
     fixed + inset:0 直接贴可视视口四条边，对布局视口误算免疫 */
  position: fixed;
  inset: 0;
  display: flex; flex-direction: column;
  overflow: hidden;   /* 内部自己滚 */
}
html, body { height: 100%; overflow: hidden; margin: 0; }
```

不要用 `height:100%`、不要用 `100vh`、不要用 `100dvh`（standalone 下都不可靠）。

### ② viewport meta

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no, interactive-widget=resizes-content">
```

- `viewport-fit=cover`：内容画到屏幕物理边缘（含 home 指示条区），这样底栏背景才能「穿过」安全区，配合 ③；
- `interactive-widget=resizes-content`：Android Chrome 键盘弹起时压缩布局视口（对齐 iOS 行为，输入框不被键盘盖住）。

### ③ 底部安全区：让底栏背景延伸穿过 home 指示条（而不是留白）

```css
.composer-wrap {
  /* 背景通过 padding 延伸到屏幕底缘；输入控件本体仍悬在指示条上方 */
  padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px));
}
/* 键盘弹起时指示条区被键盘覆盖，无需预留 → 压平 */
.composer-wrap:focus-within { padding-bottom: 4px !important; }
/* 悬浮元素（FAB/提示 pill）抬到指示条上方 */
.fab { bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
```

关键思想：**安全区不要留空，让实色 UI 填满它**——留空就是「死色带」的来源。

### ④ 键盘：只在「确认键盘弹起」时才做 visualViewport 像素级钉高

```js
let keyboardLikelyOpen = false
if (window.visualViewport) {
  const app = document.querySelector('#app')
  const applyVV = () => {
    const vv = window.visualViewport
    if (keyboardLikelyOpen && vv.height < window.innerHeight - 120) {
      // 键盘弹起时 iOS 会把 layout 视口上推（vv.offsetTop>0）。
      // 只设 height 不设 top → 应用与可视区错位 → 「整页被顶上去、上方全空白」。
      // 必须精确覆盖可视视口：top + height 一起设。
      app.style.top = Math.round(vv.offsetTop) + 'px'
      app.style.height = Math.round(vv.height) + 'px'
    } else {
      app.style.top = ''
      app.style.height = ''   // 平时交回 CSS 的 fixed+inset:0
    }
  }
  window.visualViewport.addEventListener('resize', applyVV)
  document.addEventListener('focusin', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) { keyboardLikelyOpen = true; applyVV() }
  })
  document.addEventListener('focusout', () => { keyboardLikelyOpen = false; applyVV() })
}
```

三条铁律：
1. **绝不在启动时无条件钉 vv 像素高度**（首屏 vv 偏小会把布局压短，出现更大黑边）；
2. 钉高必须用 focusin/focusout 这样的「键盘确实弹起」信号做门控；
3. 键盘态要同时设 `top = vv.offsetTop` 和 `height = vv.height`（iOS 键盘弹起先把 layout 视口顶上去，只钉 height 不管 top 会整页错位）。

## 踩坑时间线（为什么修了四次）

| 版本 | 尝试 | 结果 |
|---|---|---|
| v0.2.1 | 启动即无条件 `app.style.height = vv.height` 像素钉死 | **回归**：standalone 首屏 vv 偏小 → 整页压短，composer 下大片黑边 |
| v0.2.2 | 回退为 `height:100%`，只在键盘打开时 JS 钉高 | 底部死区回来了（根因 1 未解决） |
| v0.9.4 | 底栏背景穿过 safe-area（修根因 3） | 死色带消失，但 app 仍整体浮起 ~60pt（根因 1 仍在） |
| v0.9.5 | **`#app { position:fixed; inset:0 }`** 替代百分比高度（修根因 1）+ vv 钉高加 focusin/focusout 门控（防根因 2 复发） | **根治**。Safari 与 standalone 一致，Chromium 回归无异常 |

## 排查指纹（如果你的项目症状类似，按此对号）

1. **Safari 正常、standalone PWA 底部浮空 ~30–60pt** → 根因 1：改 `position:fixed; inset:0`。
2. **首次打开瞬间整页被压短/大黑边，之后可能恢复** → 根因 2：你在无条件使用 visualViewport 读数；加键盘门控。
3. **只有一条 ~34pt 的颜色带，输入栏本身位置对** → 根因 3：safe-area 没让背景穿过；`padding-bottom: calc(Npx + env(safe-area-inset-bottom))` + `viewport-fit=cover`。
4. **键盘弹起整页顶飞、上方全空白** → 键盘态只钉了 height 没钉 top；补 `top = vv.offsetTop`。
5. **Android 键盘盖住输入框** → viewport meta 加 `interactive-widget=resizes-content`。

## 验证清单

- [ ] standalone 冷启动：app 底边贴屏幕底缘（`getBoundingClientRect().bottom === window.screen.height` 近似；或截图检查无色带）；
- [ ] Safari 与主屏图标打开视觉一致；
- [ ] 聚焦输入框：键盘弹起、输入框贴键盘上沿、页面顶部导航仍可见（不是整页顶飞）；
- [ ] 收起键盘：布局完全复原（top/height 内联样式清空）；
- [ ] 横竖屏切换后仍正确；
- [ ] Android Chrome 键盘行为正常。

---
*文档生成自 DSH PWA 仓库的真实修复历史（commit e54f94c → 58dd6ae → 10a970e → 388f20b 及后续键盘精修），供其他项目的 coding agent 参考。*
