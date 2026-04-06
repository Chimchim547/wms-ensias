const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const commandes = await prisma.commande.findMany({
    include: { lignes: { include: { article: true } }, listePicking: true }
  });
  res.render('commandes/index', { commandes });
});

router.get('/create', async (req, res) => {
  const articles = await prisma.article.findMany();
  res.render('commandes/create', { articles });
});

router.post('/create', async (req, res) => {
  try {
    const { numero, nomClient, emailClient, adresseClient, articleIds, quantites } = req.body;
    const lignes = [];
    const ids = Array.isArray(articleIds) ? articleIds : [articleIds];
    const qtes = Array.isArray(quantites) ? quantites : [quantites];
    let prixTotal = 0;
    
    for (let i = 0; i < ids.length; i++) {
      const article = await prisma.article.findUnique({ where: { id: parseInt(ids[i]) } });
      prixTotal += article.prix * parseInt(qtes[i]);
      lignes.push({
        articleId: parseInt(ids[i]),
        quantite: parseInt(qtes[i])
      });
    }
    
    await prisma.commande.create({
      data: {
        numero, nomClient, emailClient, adresseClient, prixTotal,
        statut: 'EN_ATTENTE',
        lignes: { create: lignes }
      }
    });
    res.redirect('/commandes');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.post('/picking/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  
  const existant = await prisma.listePicking.findUnique({
    where: { commandeId: commandeId }
  });
  
  if (existant) {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: true } } }
  });
  
  const lignesPicking = commande.lignes.map(l => ({
    articleId: l.articleId,
    quantite: l.quantite
  }));
  
  await prisma.listePicking.create({
    data: {
      commandeId,
      lignes: { create: lignesPicking }
    }
  });
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'PICKING' }
  });
  
  res.redirect('/commandes');
});

router.get('/picking/:id', async (req, res) => {
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } },
      listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } } }
    }
  });
  res.render('commandes/picking', { commande });
});

router.post('/preparer/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { 
      listePicking: { include: { lignes: true } },
      lignes: true 
    }
  });
  
  if (commande.statut === 'PREPARE' || commande.statut === 'AU_QUAI' || commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  if (commande.listePicking) {
    for (const ligne of commande.listePicking.lignes) {
      await prisma.lignePicking.update({
        where: { id: ligne.id },
        data: { quantitePrelevee: ligne.quantite }
      });
    }
    
    for (const ligne of commande.lignes) {
      await prisma.ligneCommande.update({
        where: { id: ligne.id },
        data: { quantitePreparee: ligne.quantite }
      });
    }
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'PREPARE' }
  });
  
  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/deplacer-quai/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: true } } }
  });
  
  if (commande.statut === 'AU_QUAI' || commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  for (const ligne of commande.lignes) {
    if (ligne.article.emplacementId) {
      await prisma.article.update({
        where: { id: ligne.articleId },
        data: { emplacementId: null }
      });
      
      await prisma.mouvementStock.create({
        data: {
          type: 'TRANSFERT',
          quantite: ligne.quantite,
          articleId: ligne.articleId
        }
      });
    }
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'AU_QUAI' }
  });
  
  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/expedier/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: true }
  });
  
  if (commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes');
  }
  
  for (const ligne of commande.lignes) {
    await prisma.mouvementStock.create({
      data: {
        type: 'SORTIE',
        quantite: ligne.quantite,
        articleId: ligne.articleId
      }
    });
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'EXPEDIEE' }
  });
  
  res.redirect('/commandes');
});

module.exports = router;