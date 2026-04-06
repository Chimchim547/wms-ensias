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
    include: { emplacements: { include: { articles: true } } }
  });
  res.render('zones/plan', { zones });
});

module.exports = router;