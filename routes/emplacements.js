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
      article.poids <= e.poidsMax &&
      article.longueur <= e.zone.dimensionMaxLongueur &&
      article.largeur <= e.zone.dimensionMaxLargeur &&
      article.hauteur <= e.zone.dimensionMaxHauteur &&
      article.poids <= e.zone.poidsMax
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
  // Vérification emplacement
  if (article.longueur > emplacement.longueur) problemes.push('Emplacement - Longueur: ' + article.longueur + ' > ' + emplacement.longueur + ' cm');
  if (article.largeur > emplacement.largeur) problemes.push('Emplacement - Largeur: ' + article.largeur + ' > ' + emplacement.largeur + ' cm');
  if (article.hauteur > emplacement.hauteur) problemes.push('Emplacement - Hauteur: ' + article.hauteur + ' > ' + emplacement.hauteur + ' cm');
  if (article.poids > emplacement.poidsMax) problemes.push('Emplacement - Poids: ' + article.poids + ' > ' + emplacement.poidsMax + ' kg');
  // Vérification zone
  if (article.longueur > emplacement.zone.dimensionMaxLongueur) problemes.push('Zone ' + emplacement.zone.code + ' - Longueur: ' + article.longueur + ' > ' + emplacement.zone.dimensionMaxLongueur + ' cm');
  if (article.largeur > emplacement.zone.dimensionMaxLargeur) problemes.push('Zone ' + emplacement.zone.code + ' - Largeur: ' + article.largeur + ' > ' + emplacement.zone.dimensionMaxLargeur + ' cm');
  if (article.hauteur > emplacement.zone.dimensionMaxHauteur) problemes.push('Zone ' + emplacement.zone.code + ' - Hauteur: ' + article.hauteur + ' > ' + emplacement.zone.dimensionMaxHauteur + ' cm');
  if (article.poids > emplacement.zone.poidsMax) problemes.push('Zone ' + emplacement.zone.code + ' - Poids: ' + article.poids + ' > ' + emplacement.zone.poidsMax + ' kg');
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