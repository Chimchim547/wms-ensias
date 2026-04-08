const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const articles = await prisma.article.findMany({
    include: { categorie: true, emplacement: true }
  });
  res.render('articles/index', { articles });
});

router.get('/create', async (req, res) => {
  const categories = await prisma.categorie.findMany();
  res.render('articles/create', { categories });
});

router.post('/create', async (req, res) => {
  try {
    const { reference, designation, unite, longueur, largeur, hauteur, poids, prix, categorieId } = req.body;
    await prisma.article.create({
      data: {
        reference, designation, unite,
        longueur: parseFloat(longueur), largeur: parseFloat(largeur),
        hauteur: parseFloat(hauteur), poids: parseFloat(poids),
        prix: parseFloat(prix), categorieId: parseInt(categorieId)
      }
    });
    res.redirect('/articles');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.get('/edit/:id', async (req, res) => {
  const article = await prisma.article.findUnique({ where: { id: parseInt(req.params.id) } });
  const categories = await prisma.categorie.findMany();
  res.render('articles/edit', { article, categories });
});

router.post('/edit/:id', async (req, res) => {
  try {
    const { reference, designation, unite, longueur, largeur, hauteur, poids, prix, categorieId } = req.body;
    await prisma.article.update({
      where: { id: parseInt(req.params.id) },
      data: {
        reference, designation, unite,
        longueur: parseFloat(longueur), largeur: parseFloat(largeur),
        hauteur: parseFloat(hauteur), poids: parseFloat(poids),
        prix: parseFloat(prix), categorieId: parseInt(categorieId)
      }
    });
    res.redirect('/articles');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.post('/delete/:id', async (req, res) => {
  await prisma.article.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/articles');
});

router.get('/stock', async (req, res) => {
  const articles = await prisma.article.findMany({
    include: { categorie: true, emplacement: true, mouvements: true }
  });
  const articlesWithStock = articles.map(article => {
    const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    const stock = entrees - sorties;
    return { ...article, stock, enAlerte: stock <= article.seuilAlerte };
  });
  const alertes = articlesWithStock.filter(a => a.enAlerte);
  res.render('articles/stock', { articles: articlesWithStock, alertes });
});

// Taux de rotation
router.get('/roulement', async (req, res) => {
  const articles = await prisma.article.findMany({
    include: { categorie: true, mouvements: true }
  });
  
  const articlesWithRotation = articles.map(article => {
    const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    const stockActuel = entrees - sorties;
    const stockMoyen = (entrees + stockActuel) / 2;
    const tauxRotation = stockMoyen > 0 ? (sorties / stockMoyen) : 0;
    const couverture = tauxRotation > 0 ? (365 / tauxRotation).toFixed(0) : 'N/A';
    
    return {
      ...article,
      stock: stockActuel,
      entrees,
      sorties,
      stockMoyen: stockMoyen.toFixed(1),
      tauxRotation: tauxRotation.toFixed(2),
      couverture
    };
  });
  
  const totalSorties = articlesWithRotation.reduce((sum, a) => sum + a.sorties, 0);
  const totalStockMoyen = articlesWithRotation.reduce((sum, a) => sum + parseFloat(a.stockMoyen), 0);
  const tauxGlobal = totalStockMoyen > 0 ? (totalSorties / totalStockMoyen).toFixed(2) : '0.00';
  const couvertureGlobale = parseFloat(tauxGlobal) > 0 ? (365 / parseFloat(tauxGlobal)).toFixed(0) : 'N/A';
  const totalCoutSorties = articlesWithRotation.reduce((sum, a) => sum + (a.sorties * a.coutMoyenPondere), 0).toFixed(2);
  
  res.render('articles/roulement', { 
    articles: articlesWithRotation, 
    tauxGlobal,
    couvertureGlobale,
    totalCoutSorties
  });
});

module.exports = router;