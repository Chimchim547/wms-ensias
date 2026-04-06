const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const mouvements = await prisma.mouvementStock.findMany({
    include: { article: true },
    orderBy: { date: 'desc' }
  });
  res.render('mouvements/index', { mouvements });
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
  
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(newEmplacementId) }
  });
  
  await prisma.mouvementStock.create({
    data: {
      type: 'TRANSFERT',
      quantite: 1,
      articleId: parseInt(articleId)
    }
  });
  
  res.redirect('/mouvements');
});

module.exports = router;