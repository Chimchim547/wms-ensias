const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const zones = await prisma.zone.findMany({ include: { emplacements: true } });
  res.render('zones/index', { zones });
});

router.get('/create', (req, res) => res.render('zones/create'));

router.post('/create', async (req, res) => {
  const { code, type, dimensionMaxLongueur, dimensionMaxLargeur, dimensionMaxHauteur, poidsMax, couleur } = req.body;
  await prisma.zone.create({
    data: {
      code, type, couleur,
      dimensionMaxLongueur: parseFloat(dimensionMaxLongueur),
      dimensionMaxLargeur: parseFloat(dimensionMaxLargeur),
      dimensionMaxHauteur: parseFloat(dimensionMaxHauteur),
      poidsMax: parseFloat(poidsMax)
    }
  });
  res.redirect('/zones');
});

router.get('/edit/:id', async (req, res) => {
  const zone = await prisma.zone.findUnique({ where: { id: parseInt(req.params.id) } });
  res.render('zones/edit', { zone });
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
      poidsMax: parseFloat(poidsMax)
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
    include: { emplacements: { include: { articles: { include: { mouvements: true } } } } }
  });
  
  // Calculer capacité et remplissage pour chaque emplacement
  zones.forEach(z => {
    z.emplacements.forEach(e => {
      const volEmp = e.longueur * e.largeur * e.hauteur;
      
      if (e.articles.length > 0) {
        const article = e.articles[0];
        const volArticle = article.longueur * article.largeur * article.hauteur;
        
        // Capacité max basée sur volume et poids
        const capVolume = volArticle > 0 ? Math.floor(volEmp / volArticle) : 1;
        const capPoids = article.poids > 0 ? Math.floor(e.poidsMax / article.poids) : capVolume;
        const capaciteMax = Math.min(capVolume, capPoids);
        
        // Stock actuel
        const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
        const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
        const stockActuel = entrees - sorties;
        
        // Taux de remplissage
        const tauxRemplissage = capaciteMax > 0 ? Math.round((stockActuel / capaciteMax) * 100) : 100;
        
        e.capaciteMax = capaciteMax;
        e.stockActuel = stockActuel;
        e.tauxRemplissage = Math.min(tauxRemplissage, 100);
        
        if (stockActuel >= capaciteMax) {
          e.statut = 'PLEIN';
        } else {
          e.statut = 'PARTIEL';
        }
      } else {
        e.capaciteMax = 0;
        e.stockActuel = 0;
        e.tauxRemplissage = 0;
        e.statut = 'LIBRE';
      }
    });
  });
  
  res.render('zones/plan', { zones });
});

module.exports = router;