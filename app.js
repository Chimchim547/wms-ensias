require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const prisma = new PrismaClient();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'wms-ensias-secret-key',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy(
  { usernameField: 'email' },
  async (email, password, done) => {
    try {
      const user = await prisma.utilisateur.findUnique({ where: { email } });
      if (!user) return done(null, false, { message: 'Email incorrect' });
      const valid = await bcrypt.compare(password, user.motDePasse);
      if (!valid) return done(null, false, { message: 'Mot de passe incorrect' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.utilisateur.findUnique({ where: { id } });
    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.use(async (req, res, next) => {
  res.locals.user = req.user;
  res.locals.notifications = [];
  if (req.user) {
    try {
      res.locals.notifications = await prisma.notification.findMany({
        where: { destinataireRole: req.user.role },
        orderBy: { createdAt: 'desc' },
        take: 20
      });
    } catch (err) {
      res.locals.notifications = [];
    }
  }
  next();
});

function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => res.render('auth/login'));
app.post('/login', passport.authenticate('local', {
  successRedirect: '/dashboard',
  failureRedirect: '/login'
}));
app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login'));
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  const stats = {
    articles: await prisma.article.count(),
    zones: await prisma.zone.count(),
    emplacements: await prisma.emplacement.count(),
    commandes: await prisma.commande.count(),
    bonsReception: await prisma.bonReception.count(),
    inventaires: await prisma.inventaire.count(),
  };

  if (req.user.role === 'RESPONSABLE_COMMANDE') {
    stats.cmdEnAttente = await prisma.commande.count({ where: { statut: 'EN_ATTENTE' } });
    stats.cmdPicking = await prisma.commande.count({ where: { statut: { in: ['PICKING', 'PREPARE'] } } });
    stats.cmdPartielle = await prisma.commande.count({ where: { statut: 'PARTIELLE' } });
    stats.cmdAuQuai = await prisma.commande.count({ where: { statut: 'AU_QUAI' } });
    stats.cmdExpediee = await prisma.commande.count({ where: { statut: 'EXPEDIEE' } });
  }

  res.render('dashboard', { user: req.user, stats });
});

app.get('/', (req, res) => res.redirect('/login'));
// Routes notifications
app.get('/notifications/lire/:id', isAuthenticated, async (req, res) => {
  const notif = await prisma.notification.update({
    where: { id: parseInt(req.params.id) },
    data: { lue: true }
  });
  if (notif.lien) return res.redirect(notif.lien);
  res.redirect('/dashboard');
});

app.get('/notifications/tout-lire', isAuthenticated, async (req, res) => {
  await prisma.notification.updateMany({
    where: { destinataireRole: req.user.role, lue: false },
    data: { lue: true }
  });
  res.redirect('/dashboard');
});

const articlesRouter = require('./routes/articles');
const categoriesRouter = require('./routes/categories');
const zonesRouter = require('./routes/zones');
const emplacementsRouter = require('./routes/emplacements');
const receptionRouter = require('./routes/reception');
const commandesRouter = require('./routes/commandes');
const inventaireRouter = require('./routes/inventaire');
const mouvementsRouter = require('./routes/mouvements');
const utilisateursRouter = require('./routes/utilisateurs');

app.use('/articles', isAuthenticated, articlesRouter);
app.use('/categories', isAuthenticated, categoriesRouter);
app.use('/zones', isAuthenticated, zonesRouter);
app.use('/emplacements', isAuthenticated, emplacementsRouter);
app.use('/reception', isAuthenticated, receptionRouter);
app.use('/commandes', isAuthenticated, commandesRouter);
app.use('/inventaire', isAuthenticated, inventaireRouter);
app.use('/mouvements', isAuthenticated, mouvementsRouter);
app.use('/utilisateurs', isAuthenticated, utilisateursRouter);

async function createDefaultAdmin() {
  const admin = await prisma.utilisateur.findUnique({ where: { email: 'admin@wms.com' } });
  if (!admin) {
    const hash = await bcrypt.hash('admin123', 10);
    await prisma.utilisateur.create({
      data: {
        nom: 'Admin', prenom: 'WMS', email: 'admin@wms.com',
        motDePasse: hash, role: 'ADMINISTRATEUR'
      }
    });
    console.log('Admin créé: admin@wms.com / admin123');
  }
}

const PORT = 3000;
app.listen(PORT, async () => {
  await createDefaultAdmin();
  console.log(`Serveur WMS démarré sur http://localhost:${PORT}`);
});