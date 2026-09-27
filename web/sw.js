/* dsh-mobile Service Worker：Web Push 接收 + 通知点击深链。
 * 原则：页面正开着就不弹系统通知（页内已有 toast/振动）；点击直达对应会话。 */
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) {
    data = { title: 'DSH', body: event.data ? String(event.data.text()) : '' }
  }
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const visible = wins.some((w) => w.visibilityState === 'visible')
    if (visible) return   // 用户正在看：静默
    await self.registration.showNotification(data.title || 'DSH', {
      body: data.body || '',
      tag: data.tag || 'dsh-mobile',
      renotify: true,
      icon: '/m/icon-180.png',
      data: { url: data.url || '/m/' },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/m/'
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if (w.url.indexOf('/m/') >= 0) {
        try { await w.focus() } catch (e) {}
        try { w.navigate(url) } catch (e) {}
        return
      }
    }
    await clients.openWindow(url)
  })())
})
