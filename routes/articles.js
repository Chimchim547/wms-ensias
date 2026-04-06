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
// Taux de roulement
router.get('/roulement', async (req, res) => {
  const articles = await prisma.article.findMany({
    include: { categorie: true, mouvements: true }
  });
  
  const articlesWithRoulement = articles.map(article => {
    const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    const stockActuel = entrees - sorties;
    const stockMoyen = (entrees + stockActuel) / 2;
    const coutSorties = sorties * article.coutMoyenPondere;
    const valeurStockMoyen = stockMoyen * article.coutMoyenPondere;
    const tauxRoulement = valeurStockMoyen > 0 ? (coutSorties / valeurStockMoyen) : 0;
    
    return {
      ...article,
      stock: stockActuel,
      entrees,
      sorties,
      stockMoyen: stockMoyen.toFixed(1),
      coutSorties: coutSorties.toFixed(2),
      tauxRoulement: tauxRoulement.toFixed(2)
    };
  });
  
  // Calcul global
  const totalCoutSorties = articlesWithRoulement.reduce((sum, a) => sum + parseFloat(a.coutSorties), 0);
  const totalValeurStock = articlesWithRoulement.reduce((sum, a) => sum + (parseFloat(a.stockMoyen) * a.coutMoyenPondere), 0);
  const tauxGlobal = totalValeurStock > 0 ? (totalCoutSorties / totalValeurStock) : 0;
  
  res.render('articles/roulement', { 
    articles: articlesWithRoulement, 
    tauxGlobal: tauxGlobal.toFixed(2),
    totalCoutSorties: totalCoutSorties.toFixed(2)
  });
});

module.exports = router;