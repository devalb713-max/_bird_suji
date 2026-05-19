export default function launchBot(bot) {
  const launch = () => {
    bot.telegram
      .getMe()
      .then(info => {
        console.log(`✅ Bot @${info.username} connected`);
        bot.telegram.setMyCommands([
          { command: 'start', description: 'Open Sujini menu' },
          { command: 'ref', description: 'Your referral link + stats' },
          { command: 'balance', description: 'Your Sujicards + referrals' },
          { command: 'leaderboard', description: 'Top referrers' },
        ]).catch(() => {});
        bot.launch({ allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'] });
      })
      .catch(err => {
        console.error('Bot launch failed:', err.message, '— retrying in 5s');
        setTimeout(launch, 5000);
      });
  };
  launch();

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
