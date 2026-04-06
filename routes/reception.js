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

router.get('/pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const bon = await prisma.bonReception.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { 
      fournisseur: true, 
      lignes: { include: { article: true } },
      controleQualite: true 
    }
  });

  if (!bon) return res.status(404).send('Bon introuvable');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=BR-' + bon.numero + '.pdf');
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Bon de Reception', { align: 'center' });
  doc.moveDown();

  // Infos du bon
  doc.fontSize(10).font('Helvetica');
  doc.text('Numero: ' + bon.numero);
  doc.text('Date: ' + bon.date.toLocaleDateString('fr-FR'));
  doc.text('Fournisseur: ' + bon.fournisseur.nom);
  doc.text('Adresse: ' + bon.fournisseur.adresse);
  doc.text('Telephone: ' + bon.fournisseur.telephone);
  doc.moveDown();

  // Tableau des articles
  doc.font('Helvetica-Bold').fontSize(11);
  const tableTop = doc.y;
  doc.text('Reference', 50, tableTop, { width: 80 });
  doc.text('Designation', 130, tableTop, { width: 150 });
  doc.text('Qte Cmd', 280, tableTop, { width: 60 });
  doc.text('Qte Recue', 340, tableTop, { width: 70 });
  doc.text('Qte Acceptee', 410, tableTop, { width: 80 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(10);
  let y = tableTop + 25;
  
  bon.lignes.forEach(ligne => {
    doc.text(ligne.article.reference, 50, y, { width: 80 });
    doc.text(ligne.article.designation, 130, y, { width: 150 });
    doc.text(String(ligne.quantiteCommandee), 280, y, { width: 60 });
    doc.text(String(ligne.quantiteRecue), 340, y, { width: 70 });
    doc.text(String(ligne.quantiteAcceptee), 410, y, { width: 80 });
    y += 20;
  });

  // Contrôle qualité
  if (bon.controleQualite) {
    doc.moveDown(2);
    y = doc.y;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(11).text('Controle Qualite');
    doc.font('Helvetica').fontSize(10);
    doc.text('Resultat: ' + bon.controleQualite.resultat);
    doc.text('Date: ' + bon.controleQualite.dateControle.toLocaleDateString('fr-FR'));
    if (bon.controleQualite.commentaire) {
      doc.text('Commentaire: ' + bon.controleQualite.commentaire);
    }
  }

  // Pied de page
  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});
module.exports = router;