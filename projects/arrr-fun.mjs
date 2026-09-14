/**
 * arrr.fun — the MECHAROYALE platform
 *
 * A browser battle royale, free to play, spread over three surfaces that are one
 * business: `www.arrr.fun` is the homepage an ad lands on, `play.arrr.fun` is the game,
 * and the money is a one-off purchase of Core through Stripe Checkout — no subscription,
 * so the Revenue tab's recurring numbers stay empty on purpose.
 *
 * Two things about this product decide everything below.
 *
 * Nobody signs up to play. A visitor presses PLAY and is in a match as a guest, so the
 * usual lead → qualified → trial pipeline describes nobody here; the stages that matter
 * are the doors between landing and paying, and most people go through several of them
 * before they are a "lead" in any ordinary sense.
 *
 * And people sign in with X, so for most of them the game never learns an email.
 * Payments therefore cannot be matched on the address typed into Stripe's card form: the
 * game stamps its own account id onto the charge (`payment_intent_data[metadata]
 * [run_user_id]` in packages/server/src/economy/core-purchase.ts) and passes that same id
 * to `runhq.identify()`. See "Who paid?" in revenue/index.js.
 *
 *   npm run provision projects/arrr-fun.mjs
 */
export default {
  project: {
    name: 'arrr.fun',
    website: 'https://www.arrr.fun',
    currency: 'USD',
    // Deliberately unset. The smallest Core pack is a few dollars and nobody has bought
    // one through a tracked channel yet, so any number here would be invented — and the
    // audit would then report CAC against an invention. Set it once there is a real LTV.
    target_cac: null,
  },

  /**
   * The funnel, in the order a player actually goes through it.
   *
   * The keys are what `runhq.stage()` sends from packages/client/src/run-marketing.ts in
   * the game repo (its FUNNEL table) and from apps/bounty on the homepage. The game is a
   * SEPARATE REPOSITORY, so nothing mechanical holds the two lists together — changing a
   * key here without changing it there silently stops a stage moving, and the only thing
   * that would show is a funnel with a step nobody ever reaches.
   */
  stages: [
    { key: 'visit', label: 'Visit', is_conversion: false },
    // Guests play. This is the first step that means anything, and the gap between it
    // and `visit` is the homepage bounce rate an ad is really buying.
    { key: 'played', label: 'Played a match', is_conversion: false },
    { key: 'signed-in', label: 'Signed in', is_conversion: false },
    // Came back for another match, or invited someone. The two intent signals the
    // client emits between playing once and opening the store.
    { key: 'engaged', label: 'Engaged', is_conversion: false },
    // Left for stripe.com. The gap between this and the charge is checkout abandonment,
    // which is worth seeing per channel rather than as one number.
    { key: 'store', label: 'Opened checkout', is_conversion: false },
    { key: 'customer', label: 'Paid', is_conversion: true },
  ],

  /**
   * No channels yet, and that is the honest state: nothing is being spent on acquisition
   * today, and a channel invented ahead of the spend would sit at zero cost making every
   * ratio built on it meaningless.
   *
   * Attribution works without them. Everything arrives as Unattributed, which is visible
   * as its own row rather than hidden — so the first tagged campaign will separate
   * itself from the untagged baseline the moment it runs. Add a channel here when money
   * actually starts going out, and re-run the provisioner.
   */
  channels: [],
};
