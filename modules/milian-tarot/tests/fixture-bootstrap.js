/* Loaded only by fixture-server.cjs on its random isolated origin. */
(function () {
  if (!localStorage.getItem('tarotFixtureInstalled')) {
    const profile = { id: 'tarot-persona-a', nickname: '小夏', identity: '平面设计师，喜欢散步和摄影。' };
    localStorage.setItem('apiSettings', JSON.stringify({ apiUrl: 'https://tarot-fixture.invalid', apiKey: 'fixture-only-never-real', model: 'fixture-model', memoryCount: 5 }));
    localStorage.setItem('myProfile', JSON.stringify(profile));
    localStorage.setItem('userInfo', JSON.stringify({ nickname: '小夏' }));
    localStorage.setItem('friends', JSON.stringify(['a', 'b'].map((id, i) => ({ id: 'tarot-fixture-' + id,
      nickname: i ? '陈默' : '林舟', roleSetting: '温柔独立，喜欢散步和做饭。', persona: profile }))));
    localStorage.setItem('wechatCoupleSpaceStateV1', JSON.stringify({ activeCoupleFriendId: 'tarot-fixture-a', pairs: {
      'tarot-fixture-a': { status: 'accepted', friendId: 'tarot-fixture-a', acceptedAt: 1767225600000 },
      'tarot-fixture-b': { status: 'accepted', friendId: 'tarot-fixture-b', acceptedAt: 1767225600000 }
    } }));
    localStorage.setItem('tarotFixtureInstalled', '1');
  }
  window.addEventListener('load', () => {
    const splash = document.getElementById('splash-screen'); if (splash) splash.remove();
    window.tarotFixtureOpen = async function (friendId = 'tarot-fixture-a') {
      const deadline = Date.now() + 15000;
      while (document.getElementById('wechat-settings-page-fragment-anchor')) {
        if (Date.now() > deadline) throw new Error('Fixture host fragments did not finish loading');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (window.LegoMilianTarot) await window.LegoMilianTarot.close(false);
      navigateTo('wechat');
      while (currentPage !== 'wechat') await new Promise(resolve => setTimeout(resolve, 30));
      showWechatDiscover(); openCoupleSpacePage(); openCouplePrivateSpace(friendId);
    };
    window.tarotFixtureOpen();
  });
})();
