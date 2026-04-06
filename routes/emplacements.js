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
  
  // Pour chaque article, trouver les emplacements compatibles
  const articlesWithCompatible = articles.map(article => {
    const compatibles = emplacementsLibres.filter(e => 
      article.longueur <= e.longueur &&
      article.largeur <= e.largeur &&
      article.hauteur <= e.hauteur &&
      article.poids <= e.poidsMax
    );
    return { ...article, compatibles };
  });
  
  res.render('emplacements/affecter', { articles: articlesWithCompatible, emplacements: emplacementsLibres });
});

router.post('/affecter', async (req, res) => {
  const { articleId, emplacementId } = req.body;
  const article = await prisma.article.findUnique({ where: { id: parseInt(articleId) } });
  const emplacement = await prisma.emplacement.findUnique({
    where: { id: parseInt(emplacementId) },
    include: { zone: true }
  });
  
  // Double vérification côté serveur
  const problemes = [];
  if (article.longueur > emplacement.longueur) problemes.push('Longueur: ' + article.longueur + ' > ' + emplacement.longueur + ' cm');
  if (article.largeur > emplacement.largeur) problemes.push('Largeur: ' + article.largeur + ' > ' + emplacement.largeur + ' cm');
  if (article.hauteur > emplacement.hauteur) problemes.push('Hauteur: ' + article.hauteur + ' > ' + emplacement.hauteur + ' cm');
  if (article.poids > emplacement.poidsMax) problemes.push('Poids: ' + article.poids + ' > ' + emplacement.poidsMax + ' kg');
  
  if (problemes.length > 0) {
    return res.render('emplacements/erreur-affectation', {
      article,
      emplacement,
      problemes
    });
  }
  
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(emplacementId) }
  });

  await prisma.notification.create({
    data: {
      message: 'Article ' + article.reference + ' affecté à ' + emplacement.code + ' (Zone ' + emplacement.zone.code + ')',
      lien: '/zones/plan',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect('/emplacements');
});

module.exports = router;