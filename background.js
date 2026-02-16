// 拡張アイコンをクリックしたらbookmarks.htmlを新しいタブで開く
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("bookmarks.html") });
});
