import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, MessageTemplate } from "./models/db.js";

function normalizeBotHandle(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return null;
  if (s.startsWith("@")) return s;
  if (/^[a-zA-Z0-9_]{5,}$/.test(s)) return `@${s}`;
  return null;
}

async function pickBotHandle() {
  const fromEnv =
    normalizeBotHandle(process.env.BOT_USERNAME) ||
    normalizeBotHandle(process.env.BOT_LINK);
  if (fromEnv) return fromEnv;

  const docs = await MessageTemplate.find({}, { text: 1 }).lean();
  const counts = new Map();
  for (const t of docs) {
    const matches = ((t?.text || "").toString().match(/@[a-zA-Z0-9_]{5,}/g) || []);
    for (const h of matches) counts.set(h, (counts.get(h) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [k, c] of counts) { if (c > bestCount) { best = k; bestCount = c; } }
  return best;
}

// HANDLE is swapped at runtime with the real @username
const H = "HANDLE";

const TEMPLATES = [
`🔥🦅 Gigs are dry and you know it.

Sujini finds jobs for developers. When someone needs a developer, you hear about it first.

Start here → ${H}`,

`🔥🦅 You're a developer and work is slow right now.

Sujini tells you when someone needs a developer. You reply early. You get picked.

Join Sujini → ${H}`,

`🔥🦅 Sending proposals and hearing nothing back is rough.

With Sujini, you find jobs faster than anyone else. Fresh leads, no filler.

Open Sujini → ${H}`,

`🔥🦅 You're skilled. The problem is timing, not talent.

Sujini finds jobs for developers and tells you while they're still fresh.

Start here → ${H}`,

`🔥🦅 The developers getting gigs right now aren't better than you. They're just early.

Sujini tells you when someone needs a developer — before most people even see the post.

Get in → ${H}`,

`🔥🦅 You don't need more job groups. You need the right one.

With Sujini, developer leads come to you. One place. Clean feed. Real posts.

Join → ${H}`,

`🔥🦅 If your pipeline is empty, this helps.

Sujini finds jobs for developers. When a lead drops, you see it fast.

Start here → ${H}`,

`🔥🦅 Being a developer shouldn't mean being broke.

Sujini tells you when someone needs a developer — remote, freelance, contract, full-time.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Someone is looking for you right now.

With Sujini, you find jobs faster than anyone else. Less searching, more applying.

Open Sujini → ${H}`,

`🔥🦅 Real developer gigs exist. You're just seeing them too late.

Sujini finds job requests and brings them to one place. You move first.

Start here → ${H}`,

`🔥🦅 Most job groups are noise. Sujini is signal.

Sujini finds jobs for developers and posts them clean. No spam. Just leads.

Join → ${H}`,

`🔥🦅 You're tired of chasing work. Stop chasing.

Sujini tells you when someone needs a developer. You watch, you reply, you get hired.

Start here → ${H}`,

`🔥🦅 If you haven't landed a gig in a while, you're not alone.

With Sujini, developer gigs come to you. You don't have to scroll ten groups a day.

Join Sujini → ${H}`,

`🔥🦅 Applying late is the same as not applying.

Sujini finds the job requests developers miss — the ones buried in busy groups.

Get in early → ${H}`,

`🔥🦅 You build things. Someone needs exactly what you can build.

Sujini tells you when someone needs a developer, so you stop guessing and start replying.

Open Sujini → ${H}`,

`🔥🦅 If you're juggling five platforms looking for gigs, there's a shorter path.

Sujini finds jobs for developers. One place. Fast drops. First reply wins.

Start here → ${H}`,

`🔥🦅 The right gig can change your whole month. You just need to see it first.

With Sujini, you find jobs faster than anyone else. That's the only edge you need.

Join → ${H}`,

`🔥🦅 If you're a developer and you haven't worked this month, read this.

Sujini watches the communities so you don't have to. When a lead drops, you see it.

Start here → ${H}`,

`🔥🦅 Work shouldn't be this hard to find when you're a developer.

Sujini finds jobs for you. It keeps watch. You stay ready.

Join Sujini → ${H}`,

`🔥🦅 Developers who move first get picked. That's just how it works.

Sujini tells you when someone needs a developer. You move fast. That's it.

Open Sujini → ${H}`,

`🔥🦅 You're skilled. Your stack is solid. Timing is the only thing holding you back.

With Sujini, you find jobs faster than anyone else. Be early.

Start here → ${H}`,

`🔥🦅 If you're close to quitting freelance as a developer, don't.

Sujini finds jobs for developers and tells you while the post is still hot.

Join → ${H}`,

`🔥🦅 Finding work in a noisy market is a timing problem. Sujini fixes that.

Sujini tells you when someone needs a developer — then it's up to you to reply.

Get in → ${H}`,

`🔥🦅 You don't need motivation. You need gigs.

With Sujini, developer leads land in one place. Quick to check, quick to act.

Start here → ${H}`,

`🔥🦅 Most job posts die in hours. If you saw it late, it's already gone.

Sujini finds developer gigs and posts them fast. First reply wins.

Join Sujini → ${H}`,

`🔥🦅 You built your skills. Now let Sujini help you put them to work.

Sujini finds jobs for developers. When someone needs a developer, you hear about it.

Open Sujini → ${H}`,

`🔥🦅 If you're a developer and gig hunting is draining you, here's an easier way.

With Sujini, you find jobs faster than anyone else. Less noise, more real posts.

Start here → ${H}`,

`🔥🦅 Freelancing is hard when you're always the last to see the post.

Sujini tells you when someone needs a developer, before the crowd sees it.

Join → ${H}`,

`🔥🦅 Silence after proposals is demoralizing. Speed fixes that.

Sujini finds job requests for developers and brings them to you fast.

Start here → ${H}`,

`🔥🦅 You're a developer. Work should come to you, not the other way.

With Sujini, developer gigs come to you. You just have to reply.

Join Sujini → ${H}`,

`🔥🦅 Every developer group promises leads. Most deliver noise.

Sujini finds jobs for developers. Clean feed. Real posts. Fast drops.

Open Sujini → ${H}`,

`🔥🦅 You're not lazy. The market is just broken. Sujini helps you work around it.

Sujini tells you when someone needs a developer — remote, freelance, full-time.

Start here → ${H}`,

`🔥🦅 If you check ten groups every day looking for gigs, stop.

With Sujini, you find jobs faster than anyone else. One place, always fresh.

Get in → ${H}`,

`🔥🦅 The developer who replies first usually gets the job.

Sujini finds job requests and tells you while they're still fresh. Be first.

Start here → ${H}`,

`🔥🦅 No spam. No old posts. Just real developer job leads.

Sujini finds jobs for developers and posts them clean. Join and watch.

Join Sujini → ${H}`,

`🔥🦅 You haven't been unlucky. You've been late.

Sujini tells you when someone needs a developer. You stop being late.

Open Sujini → ${H}`,

`🔥🦅 Developer gigs are out there. You're just not seeing them in time.

With Sujini, you find jobs faster than anyone else. That's the whole point.

Start here → ${H}`,

`🔥🦅 One good gig can fix your whole month. Sujini helps you find it fast.

Sujini watches for people who need developers and tells you immediately.

Join → ${H}`,

`🔥🦅 You're a developer. You shouldn't have to beg for work.

Sujini finds jobs for developers. Fresh leads. No chasing required.

Start here → ${H}`,

`🔥🦅 If the market is slow for you right now, this is worth joining.

Sujini tells you when someone needs a developer. You reply early. You win.

Join Sujini → ${H}`,

`🔥🦅 Every hour you don't see a lead is an hour someone else can steal it.

With Sujini, you find jobs faster than anyone else. Time matters.

Open Sujini → ${H}`,

`🔥🦅 You're scrolling groups all day and still missing gigs.

Sujini finds jobs for developers and brings them to one clean channel.

Get in → ${H}`,

`🔥🦅 Gigs don't wait. The fast developers eat. The slow ones scroll.

Sujini tells you when someone needs a developer — fast and clean.

Start here → ${H}`,

`🔥🦅 You know your stuff. You just need to be in the right place at the right time.

Sujini finds jobs for developers and makes sure you're always in time.

Start here → ${H}`,

`🔥🦅 Being a developer in this market without a scout is working on hard mode.

Sujini is your scout. It finds jobs for you.

Join Sujini → ${H}`,

`🔥🦅 You've sent proposals. You've waited. It's not working fast enough.

Sujini tells you when someone needs a developer, so you can be first, not last.

Open Sujini → ${H}`,

`🔥🦅 If you want gigs, you need to see them before everyone else.

With Sujini, you find jobs faster than anyone else. That's the deal.

Start here → ${H}`,

`🔥🦅 You're a developer. The work exists. You're just not seeing it in time.

Sujini finds job requests for developers and drops them fast.

Join → ${H}`,

`🔥🦅 Stop scrolling. Start watching Sujini.

Sujini finds jobs for developers. Fresh every time. No old stuff.

Get in → ${H}`,

`🔥🦅 You're a developer who's tired of the noise.

Sujini tells you when someone needs a developer. That's all it does. That's enough.

Start here → ${H}`,

`🔥🦅 One tap. Join Sujini. Never miss a developer lead again.

With Sujini, you find jobs faster than anyone else. Simple.

Join Sujini → ${H}`,

`🔥🦅 You're good at what you do. Sujini makes sure the right people find you first.

Sujini finds jobs for developers and puts them where you can see them fast.

Open Sujini → ${H}`,

`🔥🦅 Developer gigs are time-sensitive. Sujini keeps you ahead.

Sujini tells you when someone needs a developer. You reply. You get picked.

Start here → ${H}`,

`🔥🦅 Freelance developer? Then you know how fast a good lead dies.

With Sujini, you find jobs faster than anyone else. Don't be late again.

Join → ${H}`,

`🔥🦅 You've been in the wrong groups. This one is different.

Sujini finds jobs for developers. Clean, fast, real.

Start here → ${H}`,

`🔥🦅 If gig hunting feels like a second full-time job, it shouldn't.

Sujini does the watching. You just reply.

Join Sujini → ${H}`,

`🔥🦅 Every day without Sujini is a day you might miss the right gig.

Sujini tells you when someone needs a developer. Be there when it drops.

Open Sujini → ${H}`,

`🔥🦅 Someone needs a developer right now. Do they know you exist?

With Sujini, you find jobs faster than anyone else. Start showing up first.

Get in → ${H}`,

`🔥🦅 The developer who sees the post first usually gets the job.

Sujini finds jobs for developers. You see it first. You reply first.

Start here → ${H}`,

`🔥🦅 You shouldn't have to work this hard to find work.

Sujini finds job requests for developers and tells you fast. Join now.

Join → ${H}`,

`🔥🦅 You're a developer. This month can be better.

Sujini tells you when someone needs a developer — remote, freelance, contract.

Start here → ${H}`,

`🔥🦅 Less searching. More replying. More gigs.

With Sujini, you find jobs faster than anyone else. That's the goal.

Join Sujini → ${H}`,

`🔥🦅 The gig you need is already posted somewhere. Sujini will find it for you.

Sujini finds jobs for developers and drops them clean. Watch the channel.

Open Sujini → ${H}`,

`🔥🦅 If you're serious about landing a developer gig, you need to be fast.

Sujini tells you when someone needs a developer. Speed is your edge.

Start here → ${H}`,

`🔥🦅 You've been patient enough. Time to get ahead of the market.

With Sujini, you find jobs faster than anyone else. No more late replies.

Join → ${H}`,

`🔥🦅 Developer gigs go to whoever replies first. Be that developer.

Sujini finds jobs for you and tells you while they're still hot.

Get in → ${H}`,

`🔥🦅 You're not the problem. The timing is.

Sujini tells you when someone needs a developer — before most people even see it.

Start here → ${H}`,

`🔥🦅 If you're a developer, you need Sujini in your corner.

With Sujini, developer leads come to you. Fast. Clean. Consistent.

Join Sujini → ${H}`,

`🔥🦅 Gigs don't find you. Sujini does.

Sujini finds jobs for developers. You stay ready. You reply fast. You get hired.

Open Sujini → ${H}`,

`🔥🦅 You're good at building. Let Sujini be good at finding.

Sujini finds job requests for developers and tells you fast. Start now.

Start here → ${H}`,

`🔥🦅 The developers who are busy right now saw the lead before you did.

With Sujini, you find jobs faster than anyone else. Get in.

Join → ${H}`,

`🔥🦅 Less noise. More gigs. That's what Sujini is for.

Sujini tells you when someone needs a developer. Clean. Fast. First.

Start here → ${H}`,

`🔥🦅 You don't need to scroll anymore. Sujini scrolls for you.

Sujini finds jobs for developers and brings them to one place.

Join Sujini → ${H}`,

`🔥🦅 If the pipeline is dry, the fix is seeing leads faster.

Sujini tells you when someone needs a developer. That's how you fix dry spells.

Open Sujini → ${H}`,

`🔥🦅 You're a developer and you deserve real opportunities, not recycled posts.

With Sujini, you find jobs faster than anyone else. Real leads. Fast drops.

Get in → ${H}`,

`🔥🦅 The market isn't out of developer gigs. You're just not seeing them in time.

Sujini finds jobs for developers and posts them before the crowd does.

Start here → ${H}`,

`🔥🦅 You built the skills. Sujini finds the clients.

Sujini tells you when someone needs a developer. Simple as that.

Join → ${H}`,

`🔥🦅 If you're a developer and you want to work, start here.

With Sujini, you find jobs faster than anyone else. Join. Watch. Reply. Win.

Start here → ${H}`,

`🔥🦅 One tab. One channel. All the developer leads.

Sujini finds jobs for developers. No scrolling required.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Someone is about to post that they need you.

Sujini finds that post and tells you. Be there to reply.

Open Sujini → ${H}`,

`🔥🦅 Tired of looking? Let Sujini look for you.

With Sujini, you find jobs faster than anyone else. Be the first reply.

Start here → ${H}`,

`🔥🦅 Leads don't wait. Sujini makes sure you don't either.

Sujini tells you when someone needs a developer. Fast and clean.

Join → ${H}`,

`🔥🦅 You're a developer. This isn't charity. This is a speed advantage.

Sujini finds jobs for developers. You see them first. You reply first.

Get in → ${H}`,

`🔥🦅 No more checking five groups every morning.

With Sujini, developer leads come to one place. Check once. Act fast.

Start here → ${H}`,

`🔥🦅 If your last gig ended and nothing has landed yet, this is your next move.

Sujini finds jobs for developers and drops them while they're still fresh.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. The leads are out there. Sujini finds them for you.

Sujini tells you when someone needs a developer. You just need to show up.

Open Sujini → ${H}`,

`🔥🦅 Speed wins in the developer job market. Sujini gives you speed.

With Sujini, you find jobs faster than anyone else. That's the whole advantage.

Start here → ${H}`,

`🔥🦅 If you want gigs, you need to know about them before anyone else does.

Sujini finds jobs for developers and tells you first. Join now.

Join → ${H}`,

`🔥🦅 You code well. You pitch well. You just need to be early.

Sujini tells you when someone needs a developer. Early is all it takes.

Start here → ${H}`,

`🔥🦅 Work is out there. You're just not in the right place to see it.

With Sujini, you find jobs faster than anyone else. One right place. Join it.

Join Sujini → ${H}`,

`🔥🦅 Developers who see the lead first don't always write the best proposal. They just reply first.

Sujini finds jobs for developers. Be the first reply.

Open Sujini → ${H}`,

`🔥🦅 If you're a developer who replies fast, Sujini is built for you.

Sujini tells you when someone needs a developer. Fast developers win here.

Get in → ${H}`,

`🔥🦅 You don't need luck. You need better timing.

With Sujini, you find jobs faster than anyone else. Timing fixed.

Start here → ${H}`,

`🔥🦅 Let Sujini do the watching. You do the winning.

Sujini finds job requests for developers and drops them fast. Join now.

Join → ${H}`,

`🔥🦅 You're a developer. Gigs shouldn't be this elusive.

Sujini tells you when someone needs a developer. Fewer misses. More wins.

Start here → ${H}`,

`🔥🦅 Someone is posting a developer job right now. Will you see it in time?

With Sujini, you find jobs faster than anyone else. Yes, you will.

Join Sujini → ${H}`,

`🔥🦅 The best gigs are gone before most developers even open the group.

Sujini finds jobs for developers and tells you before they disappear.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. You work hard. The least you deserve is a steady lead flow.

Sujini tells you when someone needs a developer. Every time. Fast.

Start here → ${H}`,

`🔥🦅 Freelance developers know the pain of seeing a great post four hours late.

With Sujini, you find jobs faster than anyone else. Never four hours late again.

Join → ${H}`,

`🔥🦅 Sujini doesn't post motivation. It posts gigs.

Sujini finds jobs for developers. That's all. Join and watch.

Get in → ${H}`,

`🔥🦅 You're a developer and you want consistent work. Start here.

Sujini tells you when someone needs a developer — before most people see it.

Start here → ${H}`,

`🔥🦅 You're not behind. You just need faster intel.

With Sujini, you find jobs faster than anyone else. Intel delivered.

Join Sujini → ${H}`,

`🔥🦅 If you reply first, you eat first. Sujini helps you reply first.

Sujini finds jobs for developers and posts them the moment they show up.

Open Sujini → ${H}`,

`🔥🦅 You've been doing this the slow way.

Sujini tells you when someone needs a developer. This is the fast way.

Start here → ${H}`,

`🔥🦅 Leads don't come to you. Sujini does.

With Sujini, you find jobs faster than anyone else. Simple switch. Big difference.

Join → ${H}`,

`🔥🦅 You're a developer. Stop working harder than you have to.

Sujini finds jobs for developers. You just show up and reply.

Start here → ${H}`,

`🔥🦅 Gig market is competitive. The edge is being fast, not perfect.

Sujini tells you when someone needs a developer. Be fast.

Join Sujini → ${H}`,

`🔥🦅 You've got the skills. Sujini gets you the timing.

With Sujini, you find jobs faster than anyone else. Skills + timing = hired.

Open Sujini → ${H}`,

`🔥🦅 If you're a developer and you want your next gig to come faster, start here.

Sujini finds jobs for developers. Watch the drops. Reply fast.

Get in → ${H}`,

`🔥🦅 The developer market rewards speed. Sujini gives you speed.

Sujini tells you when someone needs a developer. Fast, clean, consistent.

Start here → ${H}`,

`🔥🦅 You build software. Sujini builds your pipeline.

With Sujini, you find jobs faster than anyone else. Sustainable lead flow.

Join → ${H}`,

`🔥🦅 A good gig is out there right now. Someone will get it. Make it you.

Sujini finds jobs for developers and tells you first. Join now.

Start here → ${H}`,

`🔥🦅 You're a developer. Every day counts. Don't waste them on slow searches.

Sujini tells you when someone needs a developer. Check it. Reply. Win.

Join Sujini → ${H}`,

`🔥🦅 Sujini isn't another job board. It's a scout specifically for developers.

With Sujini, you find jobs faster than anyone else. Scouting done.

Open Sujini → ${H}`,

`🔥🦅 If your last three proposals went nowhere, timing was probably the issue.

Sujini finds jobs for developers and tells you while the post is still alive.

Start here → ${H}`,

`🔥🦅 You deserve to be busy as a developer. Sujini helps make that happen.

Sujini tells you when someone needs a developer. Join and stay ahead.

Join → ${H}`,

`🔥🦅 One message can turn a slow week into a good month. Sujini sends that message.

With Sujini, you find jobs faster than anyone else. Tap in.

Get in → ${H}`,

`🔥🦅 You're a developer. There's always someone who needs your skills.

Sujini finds them and tells you. You reply. That's the whole system.

Start here → ${H}`,

`🔥🦅 Slow gig months are painful. Fast intel makes them shorter.

Sujini finds jobs for developers. Intel delivered before the crowd gets there.

Join Sujini → ${H}`,

`🔥🦅 Stop relying on luck to find your next gig.

Sujini tells you when someone needs a developer. Luck removed from the equation.

Open Sujini → ${H}`,

`🔥🦅 Developers who land gigs consistently have one thing in common: they see leads early.

With Sujini, you find jobs faster than anyone else. That one thing, sorted.

Start here → ${H}`,

`🔥🦅 You check groups every day. You still miss things. Sujini doesn't.

Sujini finds jobs for developers. Nothing slips through.

Join → ${H}`,

`🔥🦅 You're a developer and the grind is real. Sujini makes it a little lighter.

Sujini tells you when someone needs a developer. You focus on replying and building.

Start here → ${H}`,

`🔥🦅 Not every gig gets reposted. If you miss it, it's gone.

With Sujini, you find jobs faster than anyone else. You won't miss it.

Join Sujini → ${H}`,

`🔥🦅 You've been searching. Start receiving instead.

Sujini finds jobs for developers. Leads delivered. You just reply.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. The gigs exist. Sujini connects the dots.

Sujini tells you when someone needs a developer. Dots connected.

Get in → ${H}`,

`🔥🦅 Good leads don't stay up long. First in, first hired.

With Sujini, you find jobs faster than anyone else. Always first in.

Start here → ${H}`,

`🔥🦅 You want to work. Someone wants a developer. Sujini introduces you.

Sujini finds jobs for developers. Join and let the introductions start.

Join → ${H}`,

`🔥🦅 You're not going to find gigs by waiting. But you will by being fast.

Sujini tells you when someone needs a developer. Fast beats waiting every time.

Start here → ${H}`,

`🔥🦅 Quiet months don't have to stay quiet.

With Sujini, you find jobs faster than anyone else. Turn the quiet around.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Your next gig is already posted somewhere.

Sujini finds it and tells you before it gets buried. Join now.

Open Sujini → ${H}`,

`🔥🦅 Freelance developers need a steady stream of leads, not just one lucky break.

Sujini finds jobs for developers consistently. Stream, not a trickle.

Start here → ${H}`,

`🔥🦅 You scrolled past the last gig because you were in the wrong place.

Sujini tells you when someone needs a developer. Right place. Right time.

Join → ${H}`,

`🔥🦅 Developers who know about gigs early win more. That's just facts.

With Sujini, you find jobs faster than anyone else. Early always wins.

Get in → ${H}`,

`🔥🦅 You're a developer. You need one good lead right now.

Sujini finds jobs for developers and drops them fast. Join and be ready.

Start here → ${H}`,

`🔥🦅 You can't rely on one platform. Sujini watches all of them for you.

Sujini tells you when someone needs a developer — wherever that post lives.

Join Sujini → ${H}`,

`🔥🦅 You're good. You're fast. You just need to know where to look.

With Sujini, you find jobs faster than anyone else. Now you know where.

Open Sujini → ${H}`,

`🔥🦅 If your phone isn't bringing you developer leads, add this channel.

Sujini finds jobs for developers. It will.

Start here → ${H}`,

`🔥🦅 You're a developer. You shouldn't have to work this hard just to find work.

Sujini tells you when someone needs a developer. Let it work for you.

Join → ${H}`,

`🔥🦅 One channel. Fresh developer leads. No noise.

With Sujini, you find jobs faster than anyone else. That's the setup.

Start here → ${H}`,

`🔥🦅 The developers getting gigs consistently are watching the right channel.

Sujini finds jobs for developers. Watch the right channel.

Join Sujini → ${H}`,

`🔥🦅 You've wasted time in the wrong groups. This is the right one.

Sujini tells you when someone needs a developer. No wasted time.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. The market owes you nothing. But Sujini gives you a head start.

With Sujini, you find jobs faster than anyone else. Take the head start.

Get in → ${H}`,

`🔥🦅 Replies that come in first get read first. Be first.

Sujini finds jobs for developers and drops them the moment they show up.

Start here → ${H}`,

`🔥🦅 You're a developer and gigs have been slow. This channel exists to fix that.

Sujini tells you when someone needs a developer. That's the fix.

Join → ${H}`,

`🔥🦅 Less time searching. More time building and applying.

With Sujini, you find jobs faster than anyone else. Time back in your hands.

Start here → ${H}`,

`🔥🦅 You've got the skills. Now get the leads to match.

Sujini finds jobs for developers. Skills meet leads. Join now.

Join Sujini → ${H}`,

`🔥🦅 If you want to land your next developer gig faster, this is how.

Sujini tells you when someone needs a developer. Faster starts here.

Open Sujini → ${H}`,

`🔥🦅 The best thing about Sujini: it doesn't sleep.

With Sujini, you find jobs faster than anyone else. 24/7 lead watch.

Start here → ${H}`,

`🔥🦅 You're a developer. Opportunity is everywhere. Timing is everything.

Sujini finds jobs for developers and makes sure you're always on time.

Join → ${H}`,

`🔥🦅 If the gig hunt has been rough, change your setup. Start with Sujini.

Sujini tells you when someone needs a developer. New setup. Better results.

Get in → ${H}`,

`🔥🦅 Being a developer means being in demand. Sujini makes sure you're in the room.

With Sujini, you find jobs faster than anyone else. In the room before the crowd.

Start here → ${H}`,

`🔥🦅 You're a developer. You reply well. You just need to reply first.

Sujini finds jobs for developers. Reply first. Get hired.

Join Sujini → ${H}`,

`🔥🦅 You're tired of the search. Sujini is the shortcut.

Sujini tells you when someone needs a developer. Shortcut right here.

Open Sujini → ${H}`,

`🔥🦅 You're not unlucky. You've just been late. Fix that now.

Sujini finds jobs for developers. No more late. Join now.

Start here → ${H}`,

`🔥🦅 Someone posted a developer job two hours ago. Did you see it?

Sujini tells you when someone needs a developer — the moment it's posted.

Join → ${H}`,

`🔥🦅 You're a developer. You deserve a steady pipeline, not a dry spell.

With Sujini, you find jobs faster than anyone else. Pipeline sorted.

Start here → ${H}`,

`🔥🦅 The developers who aren't stressing about gigs right now have better intel. Now you do too.

Sujini finds jobs for developers. Join the informed side.

Join Sujini → ${H}`,

`🔥🦅 Job post up. Ten developers apply. The first two get the call. Be one of them.

Sujini tells you when someone needs a developer. Be in the first two.

Open Sujini → ${H}`,

`🔥🦅 You work with code. Let Sujini work with leads.

With Sujini, you find jobs faster than anyone else. Roles split. You win.

Get in → ${H}`,

`🔥🦅 You're a developer. You need clients. Sujini finds them.

Sujini finds jobs for developers. Clients incoming.

Start here → ${H}`,

`🔥🦅 A slow month for gigs doesn't mean no gigs exist. It means you're not seeing them fast enough.

Sujini tells you when someone needs a developer. Slow month fixed.

Join → ${H}`,

`🔥🦅 You're already fast. Sujini makes sure you're fast on the right leads.

With Sujini, you find jobs faster than anyone else. Right leads. Right time.

Start here → ${H}`,

`🔥🦅 Freelance is a speed game. Sujini is your advantage.

Sujini finds jobs for developers. Advantage activated.

Join Sujini → ${H}`,

`🔥🦅 Every developer lead Sujini posts is a chance to land your next gig.

Sujini tells you when someone needs a developer. More chances. More wins.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Work is not the problem. Visibility is.

With Sujini, you find jobs faster than anyone else. Visibility fixed.

Start here → ${H}`,

`🔥🦅 You code well. You pitch well. You just need to pitch sooner.

Sujini finds jobs for developers and gets you there before anyone else.

Join → ${H}`,

`🔥🦅 You're a developer. Sujini is on your side.

Sujini tells you when someone needs a developer. It's that simple.

Get in → ${H}`,

`🔥🦅 The best developer for the job isn't always the one who gets it. The fastest is.

With Sujini, you find jobs faster than anyone else. Be the fastest.

Start here → ${H}`,

`🔥🦅 If you're tired of guessing where the next gig will come from, stop guessing.

Sujini finds jobs for developers. Consistently. Reliably.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Your skills are real. Your next gig is real. Let's find it.

Sujini tells you when someone needs a developer. Let's go.

Open Sujini → ${H}`,

`🔥🦅 Gig by gig, lead by lead. Sujini keeps the feed fresh for developers.

With Sujini, you find jobs faster than anyone else. Fresh every day.

Start here → ${H}`,

`🔥🦅 You're a developer and you've been patient long enough.

Sujini finds jobs for developers. Patience paid. Join now.

Join → ${H}`,

`🔥🦅 You want gigs. Sujini finds them. That's the partnership.

Sujini tells you when someone needs a developer. Join the partnership.

Start here → ${H}`,

`🔥🦅 Developer gigs don't stay up. Sujini makes sure you see them while they're live.

With Sujini, you find jobs faster than anyone else. Live leads. Fast action.

Join Sujini → ${H}`,

`🔥🦅 You're a developer who wants to work. Sujini is a channel that finds work for developers.

Sujini finds jobs for developers. Perfect match.

Open Sujini → ${H}`,

`🔥🦅 You build the product. Sujini builds the pipeline.

Sujini tells you when someone needs a developer. Pipeline incoming.

Get in → ${H}`,

`🔥🦅 If you're a developer and you want less stress about where the next gig comes from.

With Sujini, you find jobs faster than anyone else. Less stress. More work.

Start here → ${H}`,

`🔥🦅 You're a developer. This is your channel.

Sujini finds jobs for developers. Built for you. Join now.

Join → ${H}`,

`🔥🦅 You shouldn't have to search for work every single day. Sujini does it for you.

Sujini tells you when someone needs a developer. Daily searching done.

Start here → ${H}`,

`🔥🦅 You're a developer. Work is out there. Sujini brings it to your screen.

With Sujini, you find jobs faster than anyone else. Right to your screen.

Join Sujini → ${H}`,

`🔥🦅 Every lead you missed was a chance someone else took. Stop missing.

Sujini finds jobs for developers. Zero missed leads.

Open Sujini → ${H}`,

`🔥🦅 You're a developer and you want steady work. Sujini helps with that.

Sujini tells you when someone needs a developer. Steady starts here.

Start here → ${H}`,

`🔥🦅 You want to work. Someone wants to hire. Sujini makes the connection.

With Sujini, you find jobs faster than anyone else. Connection made.

Join → ${H}`,

`🔥🦅 Sujini is one channel. One focus. Developer jobs.

Sujini finds jobs for developers. Nothing else. Just that.

Get in → ${H}`,

`🔥🦅 You're a developer. The market is moving fast. Move faster.

Sujini tells you when someone needs a developer. Move faster. Join now.

Start here → ${H}`,

`🔥🦅 Fresh developer leads. No spam. No recycled posts. That's Sujini.

With Sujini, you find jobs faster than anyone else. That's the promise.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. One gig can change everything. Don't miss it.

Sujini finds jobs for developers. Don't miss it. Join now.

Open Sujini → ${H}`,

`🔥🦅 Your next client is out there right now. Sujini will find them for you.

Sujini tells you when someone needs a developer. Client found. You reply.

Start here → ${H}`,

`🔥🦅 You're a developer. You work hard. Work should be this easy to find.

With Sujini, you find jobs faster than anyone else. Easy. Join now.

Join → ${H}`,

`🔥🦅 The gig market rewards the early. Sujini makes you early.

Sujini finds jobs for developers. Early. Every time.

Start here → ${H}`,

`🔥🦅 You've been applying everywhere. Try applying early instead.

Sujini tells you when someone needs a developer. Apply early. Get hired.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. You've got what it takes. Now get in front of the people who need it.

With Sujini, you find jobs faster than anyone else. Front of the queue. Every time.

Open Sujini → ${H}`,

`🔥🦅 Less hunting. More landing. That's what Sujini is about.

Sujini finds jobs for developers. Less hunting starts here.

Get in → ${H}`,

`🔥🦅 You're a developer. Every slow week costs you. Sujini helps cut them short.

Sujini tells you when someone needs a developer. Slow weeks get shorter.

Start here → ${H}`,

`🔥🦅 If you want to work, Sujini will find the work. You just have to reply.

With Sujini, you find jobs faster than anyone else. Your job: reply.

Join → ${H}`,

`🔥🦅 You're a developer. Gigs are posted. Sujini finds them for you.

Sujini finds jobs for developers. That's the loop. Join it.

Start here → ${H}`,

`🔥🦅 If you've ever replied to a job post and gotten silence because someone replied hours earlier, this is for you.

Sujini tells you when someone needs a developer. Hours earlier becomes seconds earlier.

Join Sujini → ${H}`,

`🔥🦅 You're a developer and you want to close this month strong.

With Sujini, you find jobs faster than anyone else. Close strong. Join now.

Open Sujini → ${H}`,

`🔥🦅 Sujini doesn't wait. It watches, finds, and drops. You reply.

Sujini finds jobs for developers. Nonstop. Fast. Yours.

Start here → ${H}`,

`🔥🦅 You're a developer. You know your worth. Now get in front of people who'll pay it.

Sujini tells you when someone needs a developer. Worth, met.

Join → ${H}`,

`🔥🦅 Dry spells end when you start seeing leads before everyone else.

With Sujini, you find jobs faster than anyone else. Dry spell ending.

Get in → ${H}`,

`🔥🦅 You're a developer and you want consistency, not luck.

Sujini finds jobs for developers. Consistently. Join now.

Start here → ${H}`,

`🔥🦅 You've been relying on platforms that weren't built for developers like you.

Sujini tells you when someone needs a developer. Built for you.

Join Sujini → ${H}`,

`🔥🦅 The developers who aren't worried about gigs right now are in the right channel.

With Sujini, you find jobs faster than anyone else. Get in the right channel.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Stop stressing. Start watching Sujini.

Sujini finds jobs for developers. Stress traded for leads. Join now.

Start here → ${H}`,

`🔥🦅 Someone needs a developer today. Sujini will find it. You just need to be there.

Sujini tells you when someone needs a developer. Be there.

Join → ${H}`,

`🔥🦅 You've got the tools. You've got the skills. Sujini gets you the gigs.

With Sujini, you find jobs faster than anyone else. Tools + skills + Sujini = hired.

Start here → ${H}`,

`🔥🦅 You're a developer. The next lead is coming. Be in the right place when it does.

Sujini finds jobs for developers. Right place. Right here.

Join Sujini → ${H}`,

`🔥🦅 Gigs are a timing game. Play it better with Sujini.

Sujini tells you when someone needs a developer. Better timing. More gigs.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Your next client doesn't know you yet. Sujini is how they find out.

With Sujini, you find jobs faster than anyone else. Clients, meet developer.

Get in → ${H}`,

`🔥🦅 No motivation posts. No fluff. Just developer job leads.

Sujini finds jobs for developers. Straight to the point.

Start here → ${H}`,

`🔥🦅 You're a developer. You've been showing up. Now show up earlier.

Sujini tells you when someone needs a developer. Earlier. Every time.

Join → ${H}`,

`🔥🦅 You want to find gigs faster. This is the channel for that.

With Sujini, you find jobs faster than anyone else. This is it.

Start here → ${H}`,

`🔥🦅 You're a developer and you've been doing the work. Let Sujini do the searching.

Sujini finds jobs for developers. You do the work. Sujini does the searching.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Leads are posted daily. Sujini makes sure you see every one.

Sujini tells you when someone needs a developer. Every lead. Every day.

Open Sujini → ${H}`,

`🔥🦅 If you're a developer and you've been missing gigs, this is why and this is the fix.

With Sujini, you find jobs faster than anyone else. Miss less. Win more.

Start here → ${H}`,

`🔥🦅 You want a gig. There's a gig. Sujini connects the two.

Sujini finds jobs for developers. Connection incoming.

Join → ${H}`,

`🔥🦅 You're a developer. Stop waiting for luck. Start watching Sujini.

Sujini tells you when someone needs a developer. Luck optional.

Get in → ${H}`,

`🔥🦅 Being early is the skill most developers ignore. Sujini makes it effortless.

With Sujini, you find jobs faster than anyone else. Effortlessly early.

Start here → ${H}`,

`🔥🦅 You're skilled, available, and ready. Sujini makes sure someone sees that — fast.

Sujini finds jobs for developers. Skilled + available + Sujini = hired.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. The gig economy needs you. Get in front of it.

Sujini tells you when someone needs a developer. Front and center.

Open Sujini → ${H}`,

`🔥🦅 Job posts don't wait. You shouldn't either.

With Sujini, you find jobs faster than anyone else. Don't wait.

Start here → ${H}`,

`🔥🦅 You're a developer. Every missed lead is a missed paycheck.

Sujini finds jobs for developers. Miss fewer leads. Miss fewer paychecks.

Join → ${H}`,

`🔥🦅 You've been grinding. Let Sujini make the grind count.

Sujini tells you when someone needs a developer. Grind counting.

Start here → ${H}`,

`🔥🦅 You're a developer. Your next great gig is already posted.

With Sujini, you find jobs faster than anyone else. Find it now.

Join Sujini → ${H}`,

`🔥🦅 No fluff. No recycled posts. Just live developer leads.

Sujini finds jobs for developers. Live. Fresh. Fast.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Sujini is in your corner.

Sujini tells you when someone needs a developer. Corner secured.

Get in → ${H}`,

`🔥🦅 If you're a developer and this month has been quiet, next month can be different.

With Sujini, you find jobs faster than anyone else. Start now. Finish strong.

Start here → ${H}`,

`🔥🦅 You're a developer. One lead can change everything. Sujini brings the leads.

Sujini finds jobs for developers. Lead incoming.

Join → ${H}`,

`🔥🦅 Developer leads go fast. Sujini goes faster.

Sujini tells you when someone needs a developer. Faster than you can search.

Start here → ${H}`,

`🔥🦅 You're a developer. Work is the goal. Sujini is the path.

With Sujini, you find jobs faster than anyone else. Path. Right here.

Join Sujini → ${H}`,

`🔥🦅 You've been looking in the wrong places. Sujini is the right place.

Sujini finds jobs for developers. Right place. Start now.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. You need consistent lead flow. Sujini delivers it.

Sujini tells you when someone needs a developer. Consistent. Reliable.

Start here → ${H}`,

`🔥🦅 You're available. You're capable. Now be early.

With Sujini, you find jobs faster than anyone else. Available + capable + early = hired.

Join → ${H}`,

`🔥🦅 You're a developer. The market is loud. Sujini cuts through the noise.

Sujini finds jobs for developers. Noise cut. Signal delivered.

Get in → ${H}`,

`🔥🦅 Your next gig is out there. Sujini's already looking.

Sujini tells you when someone needs a developer. Already looking. Join now.

Start here → ${H}`,

`🔥🦅 You're a developer. Gig hunting shouldn't cost you this much time.

With Sujini, you find jobs faster than anyone else. Time back. Gigs up.

Join Sujini → ${H}`,

`🔥🦅 Fast developers get hired. Sujini makes you fast.

Sujini finds jobs for developers. Fast. Every single time.

Open Sujini → ${H}`,

`🔥🦅 You're a developer and you want your next gig. Start here.

Sujini tells you when someone needs a developer. Next gig incoming.

Start here → ${H}`,

`🔥🦅 You're a developer. Leads are dropping. Sujini makes sure you catch them.

With Sujini, you find jobs faster than anyone else. Catch every lead.

Join → ${H}`,

`🔥🦅 Someone is looking for a developer right now. Sujini knows. You should too.

Sujini finds jobs for developers. Know when they're looking.

Start here → ${H}`,

`🔥🦅 You're a developer. You put in the hours. Sujini helps those hours pay off.

Sujini tells you when someone needs a developer. Hours paying off.

Join Sujini → ${H}`,

`🔥🦅 If you're a developer, Sujini is the one channel worth keeping notifications on for.

With Sujini, you find jobs faster than anyone else. Notifications worth it.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. You want the lead before it's gone. Join Sujini.

Sujini finds jobs for developers. Before it's gone. Every time.

Get in → ${H}`,

`🔥🦅 You're a developer. Gig hunting ends here. Lead watching starts here.

Sujini tells you when someone needs a developer. Hunting ends. Watching starts.

Start here → ${H}`,

`🔥🦅 You code. Sujini scouts. Together you land gigs.

With Sujini, you find jobs faster than anyone else. Team up.

Join → ${H}`,

`🔥🦅 You're a developer. You've been patient. Now be fast.

Sujini finds jobs for developers. Patient is over. Fast starts now.

Start here → ${H}`,

`🔥🦅 Real developer job requests. Dropped fast. That's Sujini.

Sujini tells you when someone needs a developer. Real. Fast. Yours.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. You know what a good lead looks like. Sujini finds them.

With Sujini, you find jobs faster than anyone else. Good leads. All day.

Open Sujini → ${H}`,

`🔥🦅 You're a developer and you want next month to look different from this one.

Sujini finds jobs for developers. Different starts here.

Start here → ${H}`,

`🔥🦅 Sujini doesn't post hype. It posts developer job leads.

Sujini tells you when someone needs a developer. No hype. Just leads.

Join → ${H}`,

`🔥🦅 You're a developer. A good gig is one fast reply away. Sujini sets that up.

With Sujini, you find jobs faster than anyone else. One reply away.

Get in → ${H}`,

`🔥🦅 You've been in groups that don't deliver. Sujini delivers.

Sujini finds jobs for developers. Delivers. Every time.

Start here → ${H}`,

`🔥🦅 You're a developer and you're ready to work. Sujini is ready to find the work.

Sujini tells you when someone needs a developer. Ready on both sides.

Join Sujini → ${H}`,

`🔥🦅 If developer gigs were easier to find, you'd already have more of them. Sujini makes it easier.

With Sujini, you find jobs faster than anyone else. Easier. Right now.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Leads are out there. Let Sujini bring them to you.

Sujini finds jobs for developers. Brought right to you.

Start here → ${H}`,

`🔥🦅 You're a developer. The next person who posts a job needs someone like you.

Sujini tells you when someone needs a developer. You'll know right away.

Join → ${H}`,

`🔥🦅 No old leads. No filler. Just fresh developer job posts.

With Sujini, you find jobs faster than anyone else. Fresh only.

Start here → ${H}`,

`🔥🦅 You're a developer. Sujini is your scout, your lookout, your edge.

Sujini finds jobs for developers. Scout on duty.

Join Sujini → ${H}`,

`🔥🦅 You're good at your craft. Now be good at showing up first too.

Sujini tells you when someone needs a developer. Show up first.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. This channel posts when someone needs you. Watch it.

With Sujini, you find jobs faster than anyone else. Watch and win.

Get in → ${H}`,

`🔥🦅 You've got skills. Sujini has leads. This is a good match.

Sujini finds jobs for developers. Skills meets leads. Join now.

Start here → ${H}`,

`🔥🦅 You're a developer. Gig market is competitive. Sujini is your edge.

Sujini tells you when someone needs a developer. Edge activated.

Join → ${H}`,

`🔥🦅 If you're a developer, every good lead Sujini drops is a chance to land something.

With Sujini, you find jobs faster than anyone else. More chances. Join now.

Start here → ${H}`,

`🔥🦅 Developers waste hours searching. Sujini gives those hours back.

Sujini finds jobs for developers. Hours returned.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. You shouldn't be late to every good lead. Join Sujini.

Sujini tells you when someone needs a developer. On time. Every time.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. The posts are out there. Sujini reads every one for you.

With Sujini, you find jobs faster than anyone else. Every post. Read fast.

Start here → ${H}`,

`🔥🦅 You're a developer who wants to work. This is the channel.

Sujini finds jobs for developers. This is it. Join now.

Join → ${H}`,

`🔥🦅 You've been searching too hard for too long. Sujini makes it easier.

Sujini tells you when someone needs a developer. Easier. Right here.

Get in → ${H}`,

`🔥🦅 Developer leads, fast. That's Sujini.

With Sujini, you find jobs faster than anyone else. Fast. That's all.

Start here → ${H}`,

`🔥🦅 You're a developer. Job posts don't stay fresh long. Sujini gets you there early.

Sujini finds jobs for developers. Early. Always.

Join Sujini → ${H}`,

`🔥🦅 You're a developer and you want to be busy. Start with Sujini.

Sujini tells you when someone needs a developer. Busy starts here.

Open Sujini → ${H}`,

`🔥🦅 You code. You deliver. You just need someone to hire you. Sujini finds them.

With Sujini, you find jobs faster than anyone else. Hire, found.

Start here → ${H}`,

`🔥🦅 You're a developer. Sujini is the shortcut the market doesn't advertise.

Sujini finds jobs for developers. Shortcut. Right here.

Join → ${H}`,

`🔥🦅 You're a developer. If you're not using Sujini, you're searching the slow way.

Sujini tells you when someone needs a developer. Fast way starts now.

Start here → ${H}`,

`🔥🦅 You're skilled and available. That's all a client needs. Sujini finds the client.

With Sujini, you find jobs faster than anyone else. Client found.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Someone is hiring. Sujini knows where.

Sujini finds jobs for developers. Where, delivered to you.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Stop missing leads. Start watching Sujini.

Sujini tells you when someone needs a developer. Miss nothing.

Get in → ${H}`,

`🔥🦅 You're a developer. The leads are real. The timing is everything.

With Sujini, you find jobs faster than anyone else. Timing sorted.

Start here → ${H}`,

`🔥🦅 You're a developer and you want leads, not inspiration.

Sujini finds jobs for developers. Leads. Not inspiration.

Join → ${H}`,

`🔥🦅 Real leads. Real developers. Sujini connects both.

Sujini tells you when someone needs a developer. Connection made.

Start here → ${H}`,

`🔥🦅 You're a developer. Gigs exist. Sujini finds them. You reply. You work.

With Sujini, you find jobs faster than anyone else. That's the full loop.

Join Sujini → ${H}`,

`🔥🦅 If you're a developer who's tired of slow months, Sujini is the answer.

Sujini finds jobs for developers. Slow months answered.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. You want to get hired faster. Here's how.

Sujini tells you when someone needs a developer. Faster. Right here.

Start here → ${H}`,

`🔥🦅 You're skilled. Someone needs your skills. Sujini is how they meet you.

With Sujini, you find jobs faster than anyone else. Meeting arranged.

Join → ${H}`,

`🔥🦅 You're a developer. Every good lead that drops is a shot at a better month.

Sujini finds jobs for developers. Shots, incoming.

Get in → ${H}`,

`🔥🦅 You want to stop stressing about gigs. Sujini helps with that.

Sujini tells you when someone needs a developer. Stress, reduced.

Start here → ${H}`,

`🔥🦅 You're a developer and the right channel makes all the difference.

With Sujini, you find jobs faster than anyone else. Right channel. Right here.

Join Sujini → ${H}`,

`🔥🦅 You work hard. Gigs should come easier than this. Sujini makes them.

Sujini finds jobs for developers. Easier. Join now.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. You want your phone to bring you gig leads. Sujini does that.

Sujini tells you when someone needs a developer. Phone, delivering leads.

Start here → ${H}`,

`🔥🦅 Developer leads come and go fast. Sujini makes sure you're there when they come.

With Sujini, you find jobs faster than anyone else. There when it counts.

Join → ${H}`,

`🔥🦅 You're a developer. The right gig can change everything. Don't miss it.

Sujini finds jobs for developers. Miss nothing. Join now.

Start here → ${H}`,

`🔥🦅 You've been searching. Sujini makes the search unnecessary.

Sujini tells you when someone needs a developer. Search done.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Fast lead delivery. Clean channel. That's Sujini.

With Sujini, you find jobs faster than anyone else. Clean. Fast. Yours.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Don't let another good gig go to someone slower.

Sujini finds jobs for developers. Be faster. Join now.

Get in → ${H}`,

`🔥🦅 You're a developer. Sujini watches so you don't have to.

Sujini tells you when someone needs a developer. Watching handled.

Start here → ${H}`,

`🔥🦅 You're a developer. You've been doing this without an edge. Add one.

With Sujini, you find jobs faster than anyone else. Edge added.

Join → ${H}`,

`🔥🦅 Someone needs a developer. Sujini knows. Now you do too.

Sujini finds jobs for developers. In the know. Join now.

Start here → ${H}`,

`🔥🦅 You're a developer. Speed is your edge. Sujini is your speed.

Sujini tells you when someone needs a developer. Speed. Delivered.

Join Sujini → ${H}`,

`🔥🦅 You're a developer and the grind shouldn't be this loud. Sujini quiets it.

With Sujini, you find jobs faster than anyone else. Quieter grind. Better results.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. You reply well. You pitch well. Now reply first.

Sujini finds jobs for developers. First reply. Every time.

Start here → ${H}`,

`🔥🦅 You're a developer. The market is moving. Sujini keeps you ahead of it.

Sujini tells you when someone needs a developer. Ahead of the market.

Join → ${H}`,

`🔥🦅 You're a developer. You want to work. Sujini wants to help. Join.

With Sujini, you find jobs faster than anyone else. Mutual goal. Let's go.

Get in → ${H}`,

`🔥🦅 You're a developer. Leads are dropping right now. Are you seeing them?

Sujini finds jobs for developers. You will be.

Start here → ${H}`,

`🔥🦅 You want to close more gigs. You need to see more leads. Sujini fixes that.

Sujini tells you when someone needs a developer. More leads. More closes.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. You deserve to be paid consistently. Sujini helps with that.

With Sujini, you find jobs faster than anyone else. Consistent. Paid.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Lead flow is the game. Sujini runs the game for you.

Sujini finds jobs for developers. Game, running.

Start here → ${H}`,

`🔥🦅 You're a developer. The next post that says "need a developer" will be seen by Sujini.

Sujini tells you when someone needs a developer. Seen. Sent to you.

Join → ${H}`,

`🔥🦅 You're a developer. Stop working harder than you have to just to find gigs.

With Sujini, you find jobs faster than anyone else. Work smarter here.

Start here → ${H}`,

`🔥🦅 You're a developer. Sujini is the inbox you didn't know you needed.

Sujini finds jobs for developers. Inbox, loaded.

Join Sujini → ${H}`,

`🔥🦅 You've been slow to leads. Sujini fixes that without any extra effort from you.

Sujini tells you when someone needs a developer. No extra effort. Just join.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. Gig flow matters. Sujini keeps it flowing.

With Sujini, you find jobs faster than anyone else. Flowing.

Get in → ${H}`,

`🔥🦅 You're a developer. You're ready. Sujini finds the people who are also ready to hire.

Sujini finds jobs for developers. Ready meets ready.

Start here → ${H}`,

`🔥🦅 You're a developer. You want results, not motivation. Sujini delivers results.

Sujini tells you when someone needs a developer. Results. Every time.

Join → ${H}`,

`🔥🦅 You're a developer. Join Sujini. See what you've been missing.

With Sujini, you find jobs faster than anyone else. See the difference.

Start here → ${H}`,

`🔥🦅 You're a developer. Every good developer watches Sujini.

Sujini finds jobs for developers. Watch it. Win.

Join Sujini → ${H}`,

`🔥🦅 You're a developer. Clients are out there. Sujini sends them your way.

Sujini tells you when someone needs a developer. Your way.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. This is the last job channel you need.

With Sujini, you find jobs faster than anyone else. Last one. Best one.

Start here → ${H}`,

`🔥🦅 You're a developer. You want to win more gigs. This is how you start.

Sujini finds jobs for developers. Win more. Start here.

Join → ${H}`,

`🔥🦅 You're a developer. The leads are real. The drops are fast. Sujini is waiting.

Sujini tells you when someone needs a developer. Waiting for you.

Get in → ${H}`,

`🔥🦅 You're a developer. Sujini is the 🔥🦅 that watches for your next gig.

With Sujini, you find jobs faster than anyone else. 🔥🦅 on duty.

Start here → ${H}`,

`🔥🦅 You're a developer. Your skills are ready. Your next gig is ready. Meet in the middle.

Sujini finds jobs for developers. Middle ground: Sujini.

Join Sujini → ${H}`,

`🔥🦅 You've been grinding. Let Sujini make the grind count.

Sujini tells you when someone needs a developer. Grind counting.

Open Sujini → ${H}`,

`🔥🦅 You're a developer. One channel. One focus. All your leads.

With Sujini, you find jobs faster than anyone else. All here.

Start here → ${H}`,

`🔥🦅 You're a developer. You want to work this month. Start here.

Sujini finds jobs for developers. This month. Starting now.

Join → ${H}`,
];

async function main() {
  await connectDB();

  const botHandle = await pickBotHandle();
  if (!botHandle) {
    throw new Error(
      "Could not determine bot handle. Set BOT_USERNAME in env, or ensure existing templates contain an @username."
    );
  }

  const templates = TEMPLATES.map((t) => t.replace(/HANDLE/g, botHandle));
  console.log(`📝 Total templates: ${templates.length}`);

  const existing = await MessageTemplate.find({}, { _id: 1 }).sort({ createdAt: 1 }).lean();
  const existingIds = existing.map((t) => t._id.toString());

  let updated = 0, inserted = 0;

  for (let i = 0; i < existingIds.length; i++) {
    const text = templates[i % templates.length];
    await MessageTemplate.updateOne({ _id: existingIds[i] }, { $set: { text } }).catch(() => {});
    updated++;
  }

  const desiredTotal = Math.max(existingIds.length, templates.length);
  if (desiredTotal > existingIds.length) {
    const toInsert = templates
      .slice(existingIds.length, desiredTotal)
      .map((text) => ({ text }));
    if (toInsert.length) {
      const res = await MessageTemplate.insertMany(toInsert, { ordered: true });
      inserted = res?.length || 0;
    }
  }

  console.log(`✅ Done. bot=${botHandle} updated=${updated} inserted=${inserted} total=${desiredTotal}`);
}

(() => {
  void (async () => {
    try {
      await main();
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
  })();
})();