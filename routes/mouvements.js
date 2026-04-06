const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const { type, recherche } = req.query;
  
  const where = {};
  
  // Filtrer par type si demandé
  if (type) {
    where.type = type;
  }
  
  // Filtrer par rôle : chaque acteur voit les mouvements qui le concernent
  if (req.user.role === 'RESPONSABLE_RECEPTION') {
    where.type = 'ENTREE';
  } else if (req.user.role === 'RESPONSABLE_COMMANDE') {
    where.type = 'SORTIE';
  }
  // MAGASINIER et RESPONSABLE_ENTREPOT et ADMINISTRATEUR voient tout
  
  const mouvements = await prisma.mouvementStock.findMany({
    where,
    include: { article: true },
    orderBy: { date: 'desc' }
  });
  
  res.render('mouvements/index', { mouvements, filtres: { type: type || '' } });
});

router.get('/transfert', async (req, res) => {
  const articles = await prisma.article.findMany({
    where: { emplacementId: { not: null } },
    include: { emplacement: { include: { zone: true } } }
  });
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: true, articles: true }
  });
  const emplacementsLibres = emplacements.filter(e => e.articles.length === 0);
  res.render('mouvements/transfert', { articles, emplacements: emplacementsLibres });
});

router.post('/transfert', async (req, res) => {
  const { articleId, newEmplacementId } = req.body;
  
  const article = await prisma.article.findUnique({
    where: { id: parseInt(articleId) },
    include: { emplacement: true }
  });
  
  const ancienEmplacement = article.emplacement ? article.emplacement.code : 'N/A';
  
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(newEmplacementId) }
  });
  
  const nouvelEmplacement = await prisma.emplacement.findUnique({
    where: { id: parseInt(newEmplacementId) }
  });
  
  await prisma.mouvementStock.create({
    data: {
      type: 'TRANSFERT',
      quantite: 1,
      articleId: parseInt(articleId)
    }
  });

  // Notif pour le responsable entrepôt
  await prisma.notification.create({
    data: {
      message: 'Article ' + article.reference + ' déplacé de ' + ancienEmplacement + ' vers ' + nouvelEmplacement.code,
      lien: '/mouvements',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect('/mouvements');
});

module.exports = router;