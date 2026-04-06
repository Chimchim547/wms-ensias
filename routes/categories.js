const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const categories = await prisma.categorie.findMany({ include: { articles: true } });
  res.render('categories/index', { categories });
});

router.get('/create', (req, res) => res.render('categories/create'));

router.post('/create', async (req, res) => {
  await prisma.categorie.create({ data: { nom: req.body.nom, description: req.body.description } });
  res.redirect('/categories');
});

router.post('/delete/:id', async (req, res) => {
  await prisma.categorie.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/categories');
});

module.exports = router;