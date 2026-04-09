const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const zones = await prisma.zone.findMany({ include: { emplacements: true, categorie: true } });
  res.render('zones/index', { zones });
});

router.get('/create', async (req, res) => {
  const categories = await prisma.categorie.findMany();
  res.render('zones/create', { categories });
});

router.post('/create', async (req, res) => {
  const { code, type, dimensionMaxLongueur, dimensionMaxLargeur, dimensionMaxHauteur, poidsMax, couleur } = req.body;
  const { categorieId } = req.body;
  await prisma.zone.create({
    data: {
      code, type, couleur,
      dimensionMaxLongueur: parseFloat(dimensionMaxLongueur),
      dimensionMaxLargeur: parseFloat(dimensionMaxLargeur),
      dimensionMaxHauteur: parseFloat(dimensionMaxHauteur),
      poidsMax: parseFloat(poidsMax),
      categorieId: categorieId ? parseInt(categorieId) : null
    }
  });
  res.redirect('/zones');
});

router.get('/edit/:id', async (req, res) => {
  const zone = await prisma.zone.findUnique({ where: { id: parseInt(req.params.id) } });
  const categories = await prisma.categorie.findMany();
  res.render('zones/edit', { zone, categories });
});

router.post('/edit/:id', async (req, res) => {
  const { code, type, dimensionMaxLongueur, dimensionMaxLargeur, dimensionMaxHauteur, poidsMax, couleur } = req.body;
  await prisma.zone.update({
    where: { id: parseInt(req.params.id) },
    data: {
      code, type, couleur,
      dimensionMaxLongueur: parseFloat(dimensionMaxLongueur),
      dimensionMaxLargeur: parseFloat(dimensionMaxLargeur),
      dimensionMaxHauteur: parseFloat(dimensionMaxHauteur),
      poidsMax: parseFloat(poidsMax),
      categorieId: req.body.categorieId ? parseInt(req.body.categorieId) : null
    }
  });
  res.redirect('/zones');
});

router.post('/delete/:id', async (req, res) => {
  await prisma.zone.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/zones');
});

router.get('/plan', async (req, res) => {
  const zones = await prisma.zone.findMany({
    include: { emplacements: { include: { stockEmplacements: { include: { article: true } } } } }
  });
  
  zones.forEach(z => {
    z.emplacements.forEach(e => {
      const volEmp = e.longueur * e.largeur * e.hauteur;
      
      if (e.stockEmplacements && e.stockEmplacements.length > 0) {
        const se = e.stockEmplacements[0];
        const article = se.article;
        const totalQte = e.stockEmplacements.reduce((sum, s) => sum + s.quantite, 0);
        
        const volArt = article.longueur * article.largeur * article.hauteur;
        const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
        const capPoids = article.poids > 0 ? Math.floor(e.poidsMax / article.poids) : capVolume;
        const capaciteMax = Math.min(capVolume, capPoids);
        
        e.capaciteMax = capaciteMax;
        e.stockActuel = Math.min(totalQte, capaciteMax);
        e.tauxRemplissage = capaciteMax > 0 ? Math.round((e.stockActuel / capaciteMax) * 100) : 100;
        e.articleRef = article.reference;
        e.articleDesignation = article.designation;
        
        if (totalQte >= capaciteMax) {
          e.statut = 'PLEIN';
        } else if (totalQte > 0) {
          e.statut = 'PARTIEL';
        } else {
          e.statut = 'LIBRE';
        }
      } else {
        e.capaciteMax = 0;
        e.stockActuel = 0;
        e.tauxRemplissage = 0;
        e.articleRef = null;
        e.statut = 'LIBRE';
      }
    });
  });
  
  res.render('zones/plan', { zones });
});

module.exports = router;