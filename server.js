const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/aviator_bonus', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected')).catch(e => console.log(e));

// ==================== MODELS ====================
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  uid: { type: String, unique: true },
  balance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  firstDepositDone: { type: Boolean, default: false },
  welcomeBonusClaimed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', async function(next) {
  if (!this.uid) {
    let uid;
    let exists = true;
    while (exists) {
      uid = Math.floor(1000000 + Math.random() * 9000000).toString();
      exists = await mongoose.model('User').findOne({ uid });
    }
    this.uid = uid;
  }
  if (!this.referralCode) {
    this.referralCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

const User = mongoose.model('User', UserSchema);

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uid: String,
  type: { type: String, enum: ['deposit', 'withdraw', 'bet', 'win', 'bonus_welcome', 'bonus_deposit', 'bonus_referral', 'referral_commission'] },
  amount: Number,
  bonusAmount: { type: Number, default: 0 },
  status: { type: String, default: 'completed' },
  description: String,
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ==================== JWT ====================
const JWT_SECRET = 'aviator_secret_2026';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== AUTH APIs ====================
app.post('/register', async (req, res) => {
  try {
    const { phone, password, referralCode } = req.body;
    if (!phone || phone.length !== 10) return res.status(400).json({ error: '10-digit phone number daalein' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password kam se kam 4 characters' });
    
    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ error: 'Phone already registered' });

    let referrerUser = null;
    if (referralCode) {
      referrerUser = await User.findOne({ referralCode });
      if (!referrerUser) return res.status(400).json({ error: 'Invalid referral code' });
    }

    const user = new User({ phone, password, referredBy: referralCode || null });
    await user.save();

    // 🎁 Welcome Bonus ₹10-200
    const welcomeBonus = Math.floor(Math.random() * 191) + 10;
    user.bonusBalance += welcomeBonus;
    user.welcomeBonusClaimed = true;
    await user.save();

    await Transaction.create({ userId: user._id, uid: user.uid, type: 'bonus_welcome', bonusAmount: welcomeBonus, description: `Welcome bonus: ₹${welcomeBonus}` });

    // 🔗 Referral Bonus
    if (referrerUser) {
      const refBonus = Math.floor(Math.random() * 101) + 100;
      referrerUser.bonusBalance += refBonus;
      referrerUser.referralCount += 1;
      await referrerUser.save();

      user.bonusBalance += 10;
      await user.save();

      await Transaction.create({ userId: referrerUser._id, uid: referrerUser.uid, type: 'referral_commission', bonusAmount: refBonus, description: `Referral bonus: ₹${refBonus}` });
      await Transaction.create({ userId: user._id, uid: user.uid, type: 'bonus_referral', bonusAmount: 10, description: 'Referral join bonus: ₹10' });
    }

    const token = jwt.sign({ id: user._id, uid: user.uid, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { uid: user.uid, phone: user.phone, balance: user.balance, bonusBalance: user.bonusBalance, referralCode: user.referralCode, referralCount: user.referralCount, welcomeBonus, firstDepositDone: user.firstDepositDone } });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await User.findOne({ phone });
    if (!user) return res.status(400).json({ error: 'Phone ya password galat hai' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Phone ya password galat hai' });

    // 📅 Daily login bonus
    const today = new Date();
    today.setHours(0,0,0,0);
    const todayBonus = await Transaction.findOne({ userId: user._id, type: 'bonus_welcome', createdAt: { $gte: today } });
    
    let loginBonus = 0;
    if (!todayBonus) {
      loginBonus = Math.floor(Math.random() * 191) + 10;
      user.bonusBalance += loginBonus;
      await user.save();
      await Transaction.create({ userId: user._id, uid: user.uid, type: 'bonus_welcome', bonusAmount: loginBonus, description: `Daily login bonus: ₹${loginBonus}` });
    }

    const token = jwt.sign({ id: user._id, uid: user.uid, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { uid: user.uid, phone: user.phone, balance: user.balance, bonusBalance: user.bonusBalance, referralCode: user.referralCode, referralCount: user.referralCount, loginBonus, firstDepositDone: user.firstDepositDone, totalDeposited: user.totalDeposited } });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/balance', auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  res.json({ balance: user.balance, bonusBalance: user.bonusBalance, referralCode: user.referralCode, referralCount: user.referralCount, firstDepositDone: user.firstDepositDone, totalDeposited: user.totalDeposited });
});

app.post('/deposit', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 5) return res.status(400).json({ error: 'Minimum deposit ₹5' });
    
    const user = await User.findById(req.user.id);
    user.balance += amount;
    
    // 🎁 10% Deposit Bonus
    const depositBonus = Math.round(amount * 0.10);
    user.bonusBalance += depositBonus;
    
    if (!user.firstDepositDone) user.firstDepositDone = true;
    user.totalDeposited += amount;
    await user.save();

    await Transaction.create({ userId: user._id, uid: user.uid, type: 'deposit', amount, bonusAmount: depositBonus, description: `Deposit ₹${amount} + ₹${depositBonus} bonus` });
    res.json({ success: true, message: `₹${amount} deposited! ₹${depositBonus} bonus mila!`, balance: user.balance, bonusBalance: user.bonusBalance });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/withdraw', auth, async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    if (!amount || amount < 50) return res.status(400).json({ error: 'Minimum withdraw ₹50' });
    if (amount > 50000) return res.status(400).json({ error: 'Max withdraw ₹50,000' });
    if (!upiId) return res.status(400).json({ error: 'UPI ID daalein' });

    const user = await User.findById(req.user.id);
    
    // 🚫 Withdrawal eligibility check
    if (!user.firstDepositDone || user.totalDeposited < 100) {
      return res.status(400).json({ error: '❌ Withdrawal ke liye ₹100 deposit karke khelna zaroori hai!' });
    }
    
    const totalBets = await Transaction.countDocuments({ userId: user._id, type: 'bet' });
    if (totalBets < 1) {
      return res.status(400).json({ error: '❌ Withdrawal ke liye kam se kam ek baar khelna zaroori hai!' });
    }

    if (user.balance < amount) return res.status(400).json({ error: 'Balance kam hai' });

    user.balance -= amount;
    await user.save();
    await Transaction.create({ userId: user._id, uid: user.uid, type: 'withdraw', amount, status: 'pending', description: `Withdraw ₹${amount} to ${upiId}` });
    res.json({ success: true, message: `₹${amount} withdraw request submitted! Admin approve karega.`, balance: user.balance, bonusBalance: user.bonusBalance });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== GAME ENGINE ====================
const activePlayers = new Map();
let currentMultiplier = 0;
let crashPoint = 0;
let isRoundActive = false;
let isLocked = false;
let roundNumber = 0;
let roundHistory = [];
let gameInterval = null;

function calcCrash() {
  const pc = activePlayers.size;
  let pf = 1.0;
  if (pc <= 5) pf = 1.5;
  else if (pc <= 15) pf = 1.0;
  else if (pc <= 30) pf = 0.6;
  else if (pc <= 50) pf = 0.4;
  else if (pc <= 100) pf = 0.25;
  else pf = 0.15;

  let totalBet = 0;
  activePlayers.forEach(p => { totalBet += p.betAmount; });
  const bf = Math.max(0.3, 1 - (totalBet / 50000));

  roundNumber++;
  let rf = roundNumber <= 6 ? 2.0 : 1.0;

  const rand = Math.random();
  let base;
  if (rand < 0.50) base = 1 + Math.random() * 2;
  else if (rand < 0.75) base = 3 + Math.random() * 7;
  else if (rand < 0.90) base = 10 + Math.random() * 40;
  else if (rand < 0.97) base = 50 + Math.random() * 50;
  else if (rand < 0.995) base = 100 + Math.random() * 400;
  else base = 500 + Math.random() * 500;

  let crash = base * pf * bf * rf;
  crash = Math.max(1.01, Math.min(1000, crash));
  return parseFloat(crash.toFixed(2));
}

function startRound() {
  if (isRoundActive) return;
  crashPoint = calcCrash();
  currentMultiplier = 0;
  isRoundActive = true;
  isLocked = false;
  
  activePlayers.forEach(p => { p.isCashedOut = false; p.cashedOutAt = 0; });
  io.emit('roundStart', { crashPoint, roundNumber, playerCount: activePlayers.size });

  let inc = 0.01;
  gameInterval = setInterval(() => {
    currentMultiplier = parseFloat((currentMultiplier + inc).toFixed(2));
    if (crashPoint - currentMultiplier <= 0.15 && !isLocked) {
      isLocked = true;
      io.emit('lockPeriod', { message: '🔒 Locked!' });
    }
    io.emit('multiplierUpdate', { multiplier: currentMultiplier, isLocked, playerCount: activePlayers.size });
    if (currentMultiplier >= crashPoint) endRound();
  }, 80);
}

function endRound() {
  clearInterval(gameInterval);
  isRoundActive = false;
  
  activePlayers.forEach(p => { if (!p.isCashedOut) { p.isCashedOut = true; p.cashedOutAt = 0; } });
  
  roundHistory.unshift({ round: roundNumber, crashPoint, playerCount: activePlayers.size });
  if (roundHistory.length > 15) roundHistory.pop();
  
  io.emit('roundEnd', { crashPoint, roundNumber, roundHistory });
  setTimeout(() => startRound(), 8000);
}

// Socket events
io.on('connection', (socket) => {
  socket.on('joinGame', async (data) => {
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      socket.user = decoded;
      const user = await User.findById(decoded.id);
      socket.emit('gameState', { isRoundActive, currentMultiplier: isRoundActive ? currentMultiplier : 0, crashPoint: isRoundActive ? crashPoint : 0, roundNumber, roundHistory, balance: user.balance, bonusBalance: user.bonusBalance, referralCode: user.referralCode, referralCount: user.referralCount, firstDepositDone: user.firstDepositDone, totalDeposited: user.totalDeposited });
      broadcastPlayers();
    } catch(e) { socket.emit('error', { message: 'Invalid token' }); }
  });

  socket.on('placeBet', async (data) => {
    if (!isRoundActive) return socket.emit('error', { message: 'Round active nahi hai' });
    const { amount } = data;
    if (!amount || amount < 5 || amount > 10000) return socket.emit('error', { message: 'Bet ₹5-₹10,000' });
    
    const user = await User.findById(socket.user.id);
    if (!user) return;

    let remaining = amount;
    let fromReal = 0, fromBonus = 0;
    
    if (user.balance >= remaining) { fromReal = remaining; user.balance -= remaining; remaining = 0; }
    else {
      fromReal = user.balance; remaining -= user.balance; user.balance = 0;
      if (user.bonusBalance >= remaining) { fromBonus = remaining; user.bonusBalance -= remaining; remaining = 0; }
      else { fromBonus = user.bonusBalance; user.bonusBalance = 0; remaining -= user.bonusBalance; }
    }
    
    if (remaining > 0) return socket.emit('error', { message: 'Balance kam hai!' });
    await user.save();
    
    await Transaction.create({ userId: user._id, uid: user.uid, type: 'bet', amount, description: `Bet ₹${amount}` });
    
    activePlayers.set(socket.id, { uid: user.uid, betAmount: amount, isCashedOut: false, cashedOutAt: 0, socketId: socket.id });
    broadcastPlayers();
    socket.emit('betPlaced', { success: true, amount, balance: user.balance, bonusBalance: user.bonusBalance });
  });

  socket.on('cashout', async () => {
    if (!isRoundActive) return socket.emit('error', { message: 'Round active nahi' });
    if (isLocked) return socket.emit('error', { message: '🔒 Cashout locked!' });
    
    const player = activePlayers.get(socket.id);
    if (!player || player.isCashedOut) return;
    
    player.isCashedOut = true;
    player.cashedOutAt = currentMultiplier;
    const winAmount = parseFloat((player.betAmount * currentMultiplier).toFixed(2));
    
    const user = await User.findById(socket.user.id);
    user.balance += winAmount;
    await user.save();
    
    await Transaction.create({ userId: user._id, uid: user.uid, type: 'win', amount: winAmount, description: `Won ₹${winAmount} at ${currentMultiplier}x` });
    socket.emit('cashoutSuccess', { multiplier: currentMultiplier, winAmount, balance: user.balance, bonusBalance: user.bonusBalance });
    broadcastPlayers();
  });

  socket.on('disconnect', () => {
    activePlayers.delete(socket.id);
    broadcastPlayers();
  });
});

function broadcastPlayers() {
  const list = [];
  activePlayers.forEach(p => list.push({ uid: p.uid, betAmount: p.betAmount, isCashedOut: p.isCashedOut, cashedOutAt: p.cashedOutAt }));
  io.emit('allPlayers', { players: list });
}

// Start
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🚀 Aviator server running on port ${PORT}`);
  console.log(`🎰 Bonus System Active!`);
  setTimeout(() => startRound(), 3000);
});