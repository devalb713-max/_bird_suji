import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema(
  {
    userId: { type: String, default: null, unique: true, sparse: true },
    username: { type: String, default: null, unique: true, sparse: true },
  },
  { timestamps: true }
);
export const Admin = mongoose.model('Admin', adminSchema);

const accountSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    username: String,
    userId: { type: String, default: null },
    session: { type: String, default: null },
    role: { type: String, enum: ['listener', 'preacher', 'finder', 'inviter'], default: 'listener' },
    groups: [{ id: String, name: String, link: String, normalizedLink: String }],
    groupsSyncedAt: { type: Date, default: null },
    groupsSyncError: { type: String, default: null },
    searchLimitHit: { type: Boolean, default: false },
    searchLimitResetsAt: { type: Date, default: null },
    searchBotStartedAt: { type: Date, default: null },
    isJoining: { type: Boolean, default: false },
    isMessaging: { type: Boolean, default: false },
    joiningLeaseId: { type: String, default: null },
    joiningLeaseExpiresAt: { type: Date, default: null },
    joiningLeaseUpdatedAt: { type: Date, default: null },
    messagingLeaseId: { type: String, default: null },
    messagingLeaseExpiresAt: { type: Date, default: null },
    messagingLeaseUpdatedAt: { type: Date, default: null },
    listenerConnectedAt: { type: Date, default: null },
    listenerLastSeenAt: { type: Date, default: null },
    listenerLastChatId: { type: String, default: null },
    listenerLastMessageId: { type: Number, default: null },
    listenerLastError: { type: String, default: null },
    spamBotLastCheckedAt: { type: Date, default: null },
    spamBotLastStatus: { type: String, default: null },
    spamBotLastText: { type: String, default: null },
    spamBotJailedAt: { type: Date, default: null },
    spamBotLeaseId: { type: String, default: null },
    spamBotLeaseExpiresAt: { type: Date, default: null },
    spamBotLeaseUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
accountSchema.index({ role: 1, 'groups.normalizedLink': 1 });
accountSchema.index({ role: 1, 'groups.id': 1 });
export const Account = mongoose.model('Account', accountSchema);

const keywordSchema = new mongoose.Schema(
  {
    word: { type: String, required: true, unique: true },
    lockedByAccountId: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    lockExpiresAt: { type: Date, default: null },
    assignedToAccountId: { type: String, default: null, index: true },
    assignedOrder: { type: Number, default: null, index: true },
    lastProcessedAt: { type: Date, default: null, index: true },
    lastProcessedByAccountId: { type: String, default: null },
  },
  { timestamps: true }
);
export const Keyword = mongoose.model('Keyword', keywordSchema);

const botChatSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    type: { type: String, enum: ['group', 'supergroup', 'channel'], required: true },
    username: { type: String, default: null },
  },
  { timestamps: true }
);
export const BotChat = mongoose.model('BotChat', botChatSchema);

const approvedChatSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true },
    type: { type: String, enum: ['group', 'channel'], default: 'group' },
    approvedAt: { type: Date, default: Date.now },
    approvedBy: { type: String, default: null },
    inviteLink: { type: String, default: null },
    inviteLinkUpdatedAt: { type: Date, default: null },
    inviteLinkByAccountId: { type: String, default: null },
  },
  { timestamps: true }
);
export const ApprovedChat = mongoose.model('ApprovedChat', approvedChatSchema);

const botSettingsSchema = new mongoose.Schema(
  {
    requiredChannelId: { type: String, default: null },
    requiredChannelInviteLink: { type: String, default: null },
    requiredGroupId: { type: String, default: null },
    requiredGroupInviteLink: { type: String, default: null },
    jobsTargetChatId: { type: String, default: null },
    reviewDumpChatId: { type: String, default: null },
    inviterAccountId: { type: String, default: null },
    inviterAccountIds: { type: [String], default: [] },
    botPostingEnabled: { type: Boolean, default: true },
    aiAlertsEnabled: { type: Boolean, default: true },
    aiConsecutiveFails: { type: Number, default: 0 },
    aiCreditsAlertedAt: { type: Date, default: null },
    listenerGroupsAnnouncedCount: { type: Number, default: 0 },
    listenerGroupsAnnouncedAt: { type: Date, default: null },
    autoResumeWorkers: { type: Boolean, default: true },
    membershipSweepLeaseId: { type: String, default: null },
    membershipSweepLeaseExpiresAt: { type: Date, default: null },
    membershipSweepLeaseUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
export const BotSettings = mongoose.model('BotSettings', botSettingsSchema);

const botUserSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    username: { type: String, default: null },
    firstSeenAt: { type: Date, default: Date.now },
    bannedAt: { type: Date, default: null },
    bannedBy: { type: String, default: null },
    banReason: { type: String, default: null },
    mandatoryJoinedAt: { type: Date, default: null },
    joinPromptMessageId: { type: Number, default: null },
    joinPromptSentAt: { type: Date, default: null },
    onboardingGraceUntil: { type: Date, default: null },
    trialStartedAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },
    subscriptionEndsAt: { type: Date, default: null },
    pendingSubscriptionPaidAt: { type: Date, default: null },
    pendingSubscriptionMonths: { type: Number, default: 0 },
    pendingSujicardConfirmNonce: { type: String, default: null },
    pendingSujicardConfirmExpiresAt: { type: Date, default: null },
    lastSujicardConfirmNonce: { type: String, default: null },
    lastSujicardConfirmAt: { type: Date, default: null },
    trialReminder8hSentAt: { type: Date, default: null },
    trialReminder2hSentAt: { type: Date, default: null },
    expiryReminder3dSentAt: { type: Date, default: null },
    expiryReminder1dSentAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
    sujicardBalance: { type: Number, default: 0, index: true },
    referredByUserId: { type: String, default: null, index: true },
    referredAt: { type: Date, default: null },
  },
  { timestamps: true }
);
export const BotUser = mongoose.model('BotUser', botUserSchema);

const referralSchema = new mongoose.Schema(
  {
    referrerUserId: { type: String, required: true, index: true },
    referrerUsername: { type: String, default: null },
    referredUserId: { type: String, required: true, unique: true, index: true },
    referredUsername: { type: String, default: null },
    status: { type: String, enum: ['pending', 'credited', 'invalidated'], default: 'pending', index: true },
    clickedAt: { type: Date, default: Date.now, index: true },
    creditedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
referralSchema.index({ referrerUserId: 1, status: 1, createdAt: -1 });
export const Referral = mongoose.model('Referral', referralSchema);

const paymentSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    username: { type: String, default: null },
    kind: { type: String, enum: ['subscription'], default: 'subscription' },
    currency: { type: String, default: null },
    totalAmount: { type: Number, default: 0 },
    months: { type: Number, default: 1 },
    invoicePayload: { type: String, default: null },
    telegramPaymentChargeId: { type: String, default: null },
    providerPaymentChargeId: { type: String, default: null },
  },
  { timestamps: true }
);
paymentSchema.index({ userId: 1, createdAt: -1 });
export const Payment = mongoose.model('Payment', paymentSchema);

const inviteTicketSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    chatId: { type: String, required: true, index: true },
    link: { type: String, required: true },
    inviterAccountId: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: false }
);
inviteTicketSchema.index({ userId: 1, chatId: 1, revokedAt: 1 });
export const InviteTicket = mongoose.model('InviteTicket', inviteTicketSchema);

const messageTemplateSchema = new mongoose.Schema(
  { text: { type: String, required: true } },
  { timestamps: true }
);
export const MessageTemplate = mongoose.model('MessageTemplate', messageTemplateSchema);

const groupLinkSchema = new mongoose.Schema(
  {
    link: { type: String, required: true, unique: true },
    normalizedLink: { type: String, required: true, unique: true },
    sourceKeyword: { type: String, default: null },
    foundByAccountId: { type: String, default: null },
    foundAt: { type: Date, default: Date.now },

    status: { type: String, enum: ['new', 'claimed', 'joined', 'dead'], default: 'new', index: true },
    claimedByAccountId: { type: String, default: null, index: true },
    claimedRole: { type: String, enum: ['listener', 'preacher'], default: null },
    claimedAt: { type: Date, default: null },

    joinedByAccountId: { type: String, default: null, index: true },
    joinedRole: { type: String, enum: ['listener', 'preacher'], default: null },
    joinedAt: { type: Date, default: null },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);
groupLinkSchema.index({ status: 1, createdAt: 1 });
export const GroupLink = mongoose.model('GroupLink', groupLinkSchema);

const aiQueueMessageSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: null, index: true },
    listenerUsername: { type: String, default: null },
    listenerNumber: { type: String, default: null },
    chatId: { type: String, default: null, index: true },
    messageId: { type: Number, default: null, index: true },
    text: { type: String, required: true },

    senderName: { type: String, default: null },
    senderUsername: { type: String, default: null },
    senderId: { type: String, default: null },
    groupId: { type: String, default: null },
    groupLink: { type: String, default: null },
    messageLink: { type: String, default: null },

    reviewScore: { type: Number, default: null },
    reviewMatched: { type: [String], default: [] },
    reviewSentAt: { type: Date, default: null, index: true },
    reviewDumpChatId: { type: String, default: null },
    reviewDumpMessageId: { type: Number, default: null },
    reviewDecision: { type: String, enum: ['approved', 'declined'], default: null, index: true },
    reviewDecidedBy: { type: String, default: null },
    reviewDecidedAt: { type: Date, default: null },

    status: { type: String, enum: ['pending', 'processing', 'done'], default: 'pending', index: true },
    decision: { type: Boolean, default: null },
    decidedBy: { type: String, enum: ['openai', 'openrouter', 'keyword'], default: null },
    decidedAt: { type: Date, default: null },
    error: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    batchId: { type: String, default: null },
  },
  { timestamps: true }
);
aiQueueMessageSchema.index({ chatId: 1, messageId: 1 }, { unique: true, sparse: true });
aiQueueMessageSchema.index({ status: 1, createdAt: 1 });
export const AiQueueMessage = mongoose.model('AiQueueMessage', aiQueueMessageSchema);

const queuedPostSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    senderName: { type: String, default: null },
    senderUsername: { type: String, default: null },
    senderId: { type: String, default: null },
    groupId: { type: String, default: null },
    groupName: { type: String, default: null },
    groupLink: { type: String, default: null },
    messageLink: { type: String, default: null },
  },
  { timestamps: true }
);
export const QueuedPost = mongoose.model('QueuedPost', queuedPostSchema);

const postDedupeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    sourceChatId: { type: String, default: null, index: true },
    sourceMessageId: { type: Number, default: null, index: true },
    targetChatId: { type: String, default: null, index: true },
  },
  { timestamps: true }
);
postDedupeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
export const PostDedupe = mongoose.model('PostDedupe', postDedupeSchema);

const jobDmBlastSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['pending', 'processing', 'done'], default: 'pending', index: true },
    lockedAt: { type: Date, default: null },
    key: { type: String, required: true, unique: true, index: true },
    text: { type: String, required: true },
    replyMarkup: { type: mongoose.Schema.Types.Mixed, default: null },
    lastUserId: { type: String, default: null, index: true },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  { timestamps: true }
);
jobDmBlastSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });
export const JobDmBlast = mongoose.model('JobDmBlast', jobDmBlastSchema);

export async function connectDB() {
  mongoose.set('runValidators', true);
  const serverSelectionTimeoutMS = Math.max(10_000, Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 120_000));
  const connectTimeoutMS = Math.max(10_000, Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 120_000));
  const socketTimeoutMS = Math.max(10_000, Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 120_000));
  const heartbeatFrequencyMS = Math.max(5_000, Number(process.env.MONGO_HEARTBEAT_FREQUENCY_MS || 10_000));
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: 'sujini',
    serverSelectionTimeoutMS,
    connectTimeoutMS,
    socketTimeoutMS,
    heartbeatFrequencyMS,
  });
  console.log('✅ Connected to MongoDB');
}
