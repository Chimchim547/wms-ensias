const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: true, articles: true }
  });
  res.render('emplacements/index', { emplacements });
});

router.get('/create', async (req, res) => {
  const zones = await prisma.zone.findMany();
  res.render('emplacements/create', { zones });
});

router.post('/create', async (req, res) => {
  const { code, longueur, largeur, hauteur, poidsMax, zoneId } = req.body;
  await prisma.emplacement.create({
    data: {
      code,
      longueur: parseFloat(longueur), largeur: parseFloat(largeur),
      hauteur: parseFloat(hauteur), poidsMax: parseFloat(poidsMax),
      zoneId: parseInt(zoneId)
    }
  });
  res.redirect('/emplacements');
});

router.post('/delete/:id', async (req, res) => {
  await prisma.emplacement.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/emplacements');
});

router.get('/affecter', async (req, res) => {
  const articles = await prisma.article.findMany({ where: { emplacementId: null } });
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: true, articles: true }
  });
  const emplacementsLibres = emplacements.filter(e => e.articles.length === 0);
  res.render('emplacements/affecter', { articles, emplacements: emplacementsLibres });
});

router.post('/affecter', async (req, res) => {
  const { articleId, emplacementId } = req.body;
  const article = await prisma.article.findUnique({ where: { id: parseInt(articleId) } });
  const emplacement = await prisma.emplacement.findUnique({
    where: { id: parseInt(emplacementId) },
    include: { zone: true }
  });
  
  if (article.longueur > emplacement.longueur || article.largeur > emplacement.largeur ||
      article.hauteur > emplacement.hauteur || article.poids > emplacement.poidsMax) {
    return res.render('error', { message: 'Article trop grand ou trop lourd pour cet emplacement' });
  }
  
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(emplacementId) }
  });
  res.redirect('/emplacements');
});

module.exports = router;