/**
 * Rooftop — rooftop.chat
 *
 * A multiplayer place: you walk onto a patio twenty floors up, stand near people, smoke,
 * and talk. Free to enter. The money is a one-off purchase of gold through Stripe
 * Checkout, which buys objects and clothes — no subscription, so there is no MRR here
 * and the Revenue tab's recurring numbers will stay empty on purpose.
 *
 * Two things about this product decide everything below.
 *
 * It is gated at 18+ before anything else is on screen, because it depicts smoking. That
 * notice is a real step with real drop-off, and a campaign that sends the wrong audience
 * loses them there rather than at the sign-in — so it is a funnel stage, not a detail.
 *
 * And people sign in with X, Google or a password, which means for most of them the
 * product never learns an email. Payments therefore cannot be matched to leads on the
 * address typed into Stripe's card form; the roof stamps its own account id onto the
 * payment instead (`payment_intent_data[metadata][user]` in rooftop's money.js) and
 * passes that same id to `runhq.identify()`. See "Who paid?" in revenue/index.js.
 *
 *   npm run provision projects/rooftop.mjs
 */
export default {
  project: {
    name: 'Rooftop',
    website: 'https://rooftop.chat',
    currency: 'USD',
    // What one paying player may cost before the channel that brought them stops paying
    // for itself. The smallest gold pack is a few dollars and people buy more than once,
    // so this is a starting line to be moved once there is a real LTV to move it to —
    // not a measured number. The audit reports CAC against it.
    target_cac: 6,
  },

  /**
   * The funnel, in the order a person actually goes through it. The default set (lead →
   * qualified → trial → opportunity → customer) describes a sales pipeline and there is
   * no salesperson here; these are the five doors on the way in, and the question each
   * campaign is judged by is how far down them its traffic gets.
   *
   * The keys are what `runhq.stage()` sends from public/js/marketing.js in the rooftop
   * checkout; changing one here without changing it there silently stops a stage moving.
   */
  stages: [
    { key: 'visit', label: 'Landed', is_conversion: false },
    { key: 'verified', label: 'Passed 18+', is_conversion: false },
    { key: 'lead', label: 'Signed in', is_conversion: false },
    { key: 'player', label: 'Walked in', is_conversion: false },
    { key: 'customer', label: 'Bought gold', is_conversion: true },
  ],

  /**
   * The channels. Every one starts manual: nothing here is pretending to be connected,
   * and manual entry is the honest state for a channel until someone has an API token
   * for it. Switch a channel to its API on the Channels tab when there is one — the
   * match rules below are what sorts arrivals into it either way, and they do not change.
   *
   * A channel exists so that spend has somewhere to land. One that is never spent on
   * will be flagged by the audit, which is correct: it is either a channel to delete or
   * a number nobody entered.
   */
  channels: [
    {
      provider: 'x_ads',
      name: 'X Ads',
      auth_type: 'manual',
      // The roof's people are on X — it is one of the three sign-ins and the admin list
      // is X handles — so this is the first place money is likely to go.
      config: { match: { utm_source: ['x', 'twitter'], clickIds: ['twclid'] } },
    },
    {
      provider: 'reddit_ads',
      name: 'Reddit Ads',
      auth_type: 'manual',
      config: { match: { utm_source: ['reddit'], clickIds: ['rdt_cid'] } },
    },
    {
      provider: 'sponsorship',
      name: 'Streamers & video',
      auth_type: 'manual',
      // A paid video or stream is one placement at a time, and each one needs its own
      // utm_content to be worth anything: "sponsorship" as a single row cannot tell the
      // creator who brought two hundred players from the one who brought none.
      config: { match: { utm_medium: ['sponsorship', 'video', 'stream'] } },
    },
    {
      provider: 'content_seo',
      name: 'Organic & content',
      auth_type: 'manual',
      // Not free — it is somebody's time — but it is the bucket that catches search and
      // the posts that are not paid placements, and it keeps them out of Unattributed.
      config: { match: { utm_medium: ['organic', 'post', 'social'], referrers: ['google.', 'bing.', 'duckduckgo.'] } },
    },
  ],
};
