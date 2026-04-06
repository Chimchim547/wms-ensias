const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const bons = await prisma.bonReception.findMany({
    include: { fournisseur: true, lignes: { include: { article: true } }, controleQualite: true }
  });
  res.render('reception/index', { bons });
});

router.get('/create', async (req, res) => {
  const fournisseurs = await prisma.fournisseur.findMany();
  const articles = await prisma.article.findMany();
  res.render('reception/create', { fournisseurs, articles });
});

router.post('/create', async (req, res) => {
  try {
    const { numero, fournisseurId, articleIds, quantitesCommandees, quantitesRecues } = req.body;
    const lignes = [];
    const ids = Array.isArray(articleIds) ? articleIds : [articleIds];
    const qcmd = Array.isArray(quantitesCommandees) ? quantitesCommandees : [quantitesCommandees];
    const qrec = Array.isArray(quantitesRecues) ? quantitesRecues : [quantitesRecues];
    
    for (let i = 0; i < ids.length; i++) {
      lignes.push({
        articleId: parseInt(ids[i]),
        quantiteCommandee: parseInt(qcmd[i]),
        quantiteRecue: parseInt(qrec[i]),
        quantiteAcceptee: 0
      });
    }
    
    await prisma.bonReception.create({
      data: {
        numero,
        fournisseurId: parseInt(fournisseurId),
        lignes: { create: lignes }
      }
    });

    await prisma.notification.create({
      data: {
        message: `Nouveau bon de réception ${numero} créé avec ${ids.length} article(s). Contrôle qualité en attente.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });

    res.redirect('/reception');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.get('/controle/:id', async (req, res) => {
  const bon = await prisma.bonReception.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } }, fournisseur: true }
  });
  res.render('reception/controle', { bon });
});

router.post('/controle/:id', async (req, res) => {
  const { resultat, commentaire, quantitesAcceptees } = req.body;
  const bonId = parseInt(req.params.id);
  
  await prisma.controleQualite.create({
    data: { resultat, commentaire, bonReceptionId: bonId }
  });
  
  const bon = await prisma.bonReception.findUnique({
    where: { id: bonId },
    include: { lignes: true }
  });
  
  const qas = Array.isArray(quantitesAcceptees) ? quantitesAcceptees : [quantitesAcceptees];
  
  for (let i = 0; i < bon.lignes.length; i++) {
    const qa = parseInt(qas[i]) || 0;
    await prisma.ligneBonReception.update({
      where: { id: bon.lignes[i].id },
      data: { quantiteAcceptee: qa }
    });
    
    if (resultat === 'conforme' || resultat === 'partiellement_conforme') {
      await prisma.mouvementStock.create({
        data: {
          type: 'ENTREE',
          quantite: qa,
          articleId: bon.lignes[i].articleId
        }
      });
      
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      const mouvements = await prisma.mouvementStock.findMany({
        where: { articleId: article.id, type: 'ENTREE' }
      });
      const totalQte = mouvements.reduce((sum, m) => sum + m.quantite, 0);
      const newCump = totalQte > 0 ? ((article.coutMoyenPondere * (totalQte - qa)) + (article.prix * qa)) / totalQte : article.prix;
      await prisma.article.update({
        where: { id: article.id },
        data: { coutMoyenPondere: newCump }
      });
    }
  }

  if (resultat === 'conforme') {
    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : contrôle qualité conforme ✓. Stock mis à jour. Veuillez affecter les articles aux emplacements.`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else if (resultat === 'partiellement_conforme') {
    await prisma.notification.create({
      data: {
        message: `⚠ Bon ${bon.numero} : contrôle partiellement conforme. Stock mis à jour avec les quantités acceptées. Vérifiez les emplacements.`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else {
    await prisma.notification.create({
      data: {
        message: `❌ Bon ${bon.numero} : marchandise non conforme et refusée. Aucune entrée en stock.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  res.redirect('/reception');
});

router.get('/fournisseurs', async (req, res) => {
  const fournisseurs = await prisma.fournisseur.findMany();
  res.render('reception/fournisseurs', { fournisseurs });
});

router.post('/fournisseurs/create', async (req, res) => {
  const { nom, adresse, telephone, email } = req.body;
  await prisma.fournisseur.create({ data: { nom, adresse, telephone, email } });
  res.redirect('/reception/fournisseurs');
});

module.exports = router;