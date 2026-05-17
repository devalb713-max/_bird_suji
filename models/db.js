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
    groups: [{ id: String, name: String, link: String }],
    searchLimitHit: { type: Boolean, default: false },
    searchLimitResetsAt: { type: Date, default: null },
    isJoining: { type: Boolean, default: false },
    isMessaging: { type: Boolean, default: false },
  },
  { timestamps: true }
);
export const Account = mongoose.model('Account', accountSchema);

const keywordSchema = new mongoose.Schema(
  {
    word: { type: String, required: true, unique: true },
    lockedByAccountId: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    lockExpiresAt: { type: Date, default: null },
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
    inviterAccountId: { type: String, default: null },
    inviterAccountIds: { type: [String], default: [] },
    botPostingEnabled: { type: Boolean, default: true },
    aiAlertsEnabled: { type: Boolean, default: true },
    aiConsecutiveFails: { type: Number, default: 0 },
    aiCreditsAlertedAt: { type: Date, default: null },
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
    trialStartedAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },
    subscriptionEndsAt: { type: Date, default: null },
    pendingSubscriptionPaidAt: { type: Date, default: null },
    pendingSubscriptionMonths: { type: Number, default: 0 },
    trialReminder8hSentAt: { type: Date, default: null },
    trialReminder2hSentAt: { type: Date, default: null },
    expiryReminder3dSentAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
export const BotUser = mongoose.model('BotUser', botUserSchema);

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
    chatId: { type: String, default: null, index: true },
    messageId: { type: Number, default: null, index: true },
    text: { type: String, required: true },

    senderName: { type: String, default: null },
    senderUsername: { type: String, default: null },
    senderId: { type: String, default: null },
    groupLink: { type: String, default: null },
    messageLink: { type: String, default: null },

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
    groupName: { type: String, default: null },
    groupLink: { type: String, default: null },
    messageLink: { type: String, default: null },
  },
  { timestamps: true }
);
export const QueuedPost = mongoose.model('QueuedPost', queuedPostSchema);

export async function connectDB() {
  mongoose.set('runValidators', true);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'sujini' });
  console.log('✅ Connected to MongoDB');
}
