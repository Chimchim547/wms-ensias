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
    
    let surplus = false;
    let manquant = false;
    const ecarts = [];
    
    for (let i = 0; i < ids.length; i++) {
      const qc = parseInt(qcmd[i]);
      const qr = parseInt(qrec[i]);
      const ecart = qr - qc;
      
      if (ecart < 0) manquant = true;
      if (ecart > 0) surplus = true;
      
      const article = await prisma.article.findUnique({ where: { id: parseInt(ids[i]) } });
      if (ecart !== 0) {
        ecarts.push(article.reference + ': commandé ' + qc + ', reçu ' + qr + ' (écart: ' + (ecart > 0 ? '+' : '') + ecart + ')');
      }
      
      lignes.push({
        articleId: parseInt(ids[i]),
        quantiteCommandee: qc,
        quantiteRecue: qr,
        quantiteAcceptee: 0,
        quantiteRefusee: 0,
        statutQualite: 'EN_ATTENTE'
      });
    }
    
    await prisma.bonReception.create({
      data: {
        numero,
        fournisseurId: parseInt(fournisseurId),
        lignes: { create: lignes }
      }
    });

    if (manquant) {
      const fournisseur = await prisma.fournisseur.findUnique({ where: { id: parseInt(fournisseurId) } });
      await prisma.notification.create({
        data: {
          message: `Bon ${numero} : ÉCART QUANTITATIF détecté ! ${ecarts.join(', ')}. Fournisseur: ${fournisseur.nom}. Contrôle qualité en attente.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
      await prisma.notification.create({
        data: {
          message: `Réception partielle - Bon ${numero} : quantités manquantes détectées. ${ecarts.join(', ')}. Fournisseur: ${fournisseur.nom}.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_ENTREPOT'
        }
      });
    } else if (surplus) {
      const fournisseur = await prisma.fournisseur.findUnique({ where: { id: parseInt(fournisseurId) } });
      await prisma.notification.create({
        data: {
          message: `Bon ${numero} : SURPLUS détecté ! ${ecarts.join(', ')}. Fournisseur: ${fournisseur.nom}. Vérifiez et procédez au contrôle qualité.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
    } else {
      await prisma.notification.create({
        data: {
          message: `Bon ${numero} : quantités conformes. ${ids.length} article(s). Contrôle qualité en attente.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
    }

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
  const { resultat, commentaire, quantitesAcceptees, actions, motifs, motifAutres } = req.body;
  const motAutres = Array.isArray(motifAutres) ? motifAutres : [motifAutres];
  const bonId = parseInt(req.params.id);
  
  await prisma.controleQualite.create({
    data: { resultat, commentaire, bonReceptionId: bonId }
  });
  
  const bon = await prisma.bonReception.findUnique({
    where: { id: bonId },
    include: { lignes: true, fournisseur: true }
  });
  
  const qas = Array.isArray(quantitesAcceptees) ? quantitesAcceptees : [quantitesAcceptees];
  const acts = Array.isArray(actions) ? actions : [actions];
  const mots = Array.isArray(motifs) ? motifs : [motifs];
  
  const articlesRetour = [];
  const articlesQuarantaine = [];
  const articlesReserve = [];
  
  for (let i = 0; i < bon.lignes.length; i++) {
    const action = acts[i] || 'aucune';
    let qa = parseInt(qas[i]) || 0;
    let qteRefusee = bon.lignes[i].quantiteRecue - qa;
    let statut = 'ACCEPTE';
    
    if (action === 'accepter_reserve') {
      // Accepté avec réserve = tout est accepté, rien n'est refusé
      qteRefusee = bon.lignes[i].quantiteRecue - qa;
      statut = 'ACCEPTE_RESERVE';
    } else if (qteRefusee > 0 && action === 'quarantaine') {
      statut = 'QUARANTAINE';
    } else if (qteRefusee > 0 && action === 'retour_fournisseur') {
      statut = 'RETOUR';
    } else if (qa === 0) {
      statut = 'REFUSE';
    }

    const motifFinal = mots[i] === 'autre' ? (motAutres[i] || 'Non spécifié') : (mots[i] || 'Non spécifié');

    // Si accepté avec réserve, tout est accepté
    const qteAccepteeFinale = action === 'accepter_reserve' ? bon.lignes[i].quantiteRecue : qa;
    const qteRefuseeFinale = action === 'accepter_reserve' ? 0 : qteRefusee;
    
    await prisma.ligneBonReception.update({
      where: { id: bon.lignes[i].id },
      data: { 
        quantiteAcceptee: qteAccepteeFinale,
        quantiteRefusee: qteRefuseeFinale,
        actionNonConforme: action,
        statutQualite: statut,
        observations: qteRefusee > 0 
          ? (bon.lignes[i].observations ? bon.lignes[i].observations + ' || QUALITE - Action: ' : 'QUALITE - Action: ') + action + ' | Motif: ' + motifFinal + ' | Refusés: ' + qteRefusee 
          : bon.lignes[i].observations || null
      }
    });
    
    if ((resultat === 'conforme' || resultat === 'partiellement_conforme') && qa > 0) {
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
    
    if (action === 'accepter_reserve' && bon.lignes[i].quantiteRecue > qa) {
      // Les unités "avec réserve" entrent aussi en stock
      await prisma.mouvementStock.create({
        data: {
          type: 'ENTREE',
          quantite: bon.lignes[i].quantiteRecue - qa,
          articleId: bon.lignes[i].articleId
        }
      });
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      articlesReserve.push(article.reference + ' - ' + article.designation + ' (' + qteRefusee + ' avec réserve)');
    }
    
    if (action === 'retour_fournisseur' && qteRefusee > 0) {
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      articlesRetour.push({ article, quantite: qteRefusee });
    }
    
    if (action === 'quarantaine' && qteRefusee > 0) {
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      articlesQuarantaine.push({ article, quantite: qteRefusee });
    }
  }

  if (resultat === 'conforme') {
    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : contrôle qualité conforme. Stock mis à jour. Veuillez affecter les articles.`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else if (resultat === 'partiellement_conforme') {
    let details = '';
    if (articlesRetour.length > 0) details += ' Retour fournisseur: ' + articlesRetour.map(a => a.article.reference + '(' + a.quantite + ')').join(', ') + '.';
    if (articlesQuarantaine.length > 0) details += ' Quarantaine: ' + articlesQuarantaine.map(a => a.article.reference + '(' + a.quantite + ')').join(', ') + '.';
    if (articlesReserve.length > 0) details += ' Acceptés avec réserve: ' + articlesReserve.join(', ') + '.';
    
    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : partiellement conforme. Stock mis à jour avec les quantités acceptées.${details}`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else {
    let details = '';
    if (articlesRetour.length > 0) details += ' Retour fournisseur prévu.';
    if (articlesQuarantaine.length > 0) details += ' Articles mis en quarantaine.';
    
    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : non conforme. Aucune entrée en stock.${details}`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  if (articlesRetour.length > 0) {
    const listeRetour = articlesRetour.map(a => a.article.reference + ' - ' + a.article.designation + ' (qte: ' + a.quantite + ')').join(', ');
    await prisma.notification.create({
      data: {
        message: `RETOUR FOURNISSEUR - Bon ${bon.numero} : ${listeRetour}. Fournisseur: ${bon.fournisseur.nom}. Veuillez préparer le bon de retour.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });
    await prisma.notification.create({
      data: {
        message: `Retour fournisseur prévu pour ${bon.fournisseur.nom} : ${listeRetour}. Bon ${bon.numero}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  if (articlesQuarantaine.length > 0) {
    const listeQuarantaine = articlesQuarantaine.map(a => a.article.reference + ' - ' + a.article.designation + ' (qte: ' + a.quantite + ')').join(', ');
    await prisma.notification.create({
      data: {
        message: `QUARANTAINE - Bon ${bon.numero} : ${listeQuarantaine}. Articles bloqués en attente de décision.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  // Vérifier backorders
  for (let i = 0; i < bon.lignes.length; i++) {
    const qa = parseInt(qas[i]) || 0;
    if (qa > 0) {
      const backorders = await prisma.commande.findMany({
        where: { statut: 'BACKORDER' },
        include: { lignes: { where: { articleId: bon.lignes[i].articleId } } }
      });
      for (const bo of backorders) {
        if (bo.lignes.length > 0) {
          const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
          await prisma.notification.create({
            data: {
              message: `Réapprovisionnement : ${article.reference} - ${article.designation} est de nouveau en stock ! Le backorder ${bo.numero} peut être traité.`,
              lien: '/commandes',
              destinataireRole: 'RESPONSABLE_COMMANDE'
            }
          });
        }
      }
    }
  }

  // Vérifier si le stock dépasse la capacité des emplacements
  for (let i = 0; i < bon.lignes.length; i++) {
    const qa = parseInt(qas[i]) || 0;
    if (qa > 0) {
      const articleCheck = await prisma.article.findUnique({
        where: { id: bon.lignes[i].articleId },
        include: { emplacement: true, mouvements: true }
      });
      
      if (articleCheck.emplacement) {
        const volEmp = articleCheck.emplacement.longueur * articleCheck.emplacement.largeur * articleCheck.emplacement.hauteur;
        const volArt = articleCheck.longueur * articleCheck.largeur * articleCheck.hauteur;
        const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
        const capPoids = articleCheck.poids > 0 ? Math.floor(articleCheck.emplacement.poidsMax / articleCheck.poids) : capVolume;
        const capaciteMax = Math.min(capVolume, capPoids);
        
        const entrees = articleCheck.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
        const sorties = articleCheck.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
        const stockActuel = entrees - sorties;
        
        if (stockActuel > capaciteMax) {
          const excedent = stockActuel - capaciteMax;
          await prisma.notification.create({
            data: {
              message: `CAPACITÉ DÉPASSÉE - ${articleCheck.reference} : stock ${stockActuel} dépasse la capacité de ${articleCheck.emplacement.code} (max ${capaciteMax}). ${excedent} unité(s) à affecter à un autre emplacement.`,
              lien: '/emplacements/affecter',
              destinataireRole: 'RESPONSABLE_ENTREPOT'
            }
          });
        }
      }
    }
  }

  // Vérifier les commandes en attente de stock
  const commandesEnAttente = await prisma.commande.findMany({
    where: { statut: 'EN_ATTENTE_STOCK' },
    include: { lignes: { include: { article: { include: { mouvements: true } } } } }
  });
  
  for (const cmd of commandesEnAttente) {
    let toutDispo = true;
    for (const ligne of cmd.lignes) {
      const ent = ligne.article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
      const sor = ligne.article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
      if (ent - sor < ligne.quantite) {
        toutDispo = false;
        break;
      }
    }
    if (toutDispo) {
      await prisma.notification.create({
        data: {
          message: 'Stock disponible pour ' + cmd.numero + ' ! Vous pouvez relancer le picking.',
          lien: '/commandes',
          destinataireRole: 'RESPONSABLE_COMMANDE'
        }
      });
    }
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
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Infos bon + fournisseur
  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Bon de reception:', 50, infoY);
  doc.font('Helvetica');
  doc.text('Numero: ' + bon.numero, 50, infoY + 15);
  doc.text('Date: ' + bon.date.toLocaleDateString('fr-FR'), 50, infoY + 30);
  if (bon.controleQualite) {
    doc.text('Resultat: ' + bon.controleQualite.resultat, 50, infoY + 45);
  }

  doc.font('Helvetica-Bold').text('Fournisseur:', 350, infoY);
  doc.font('Helvetica');
  doc.text(bon.fournisseur.nom, 350, infoY + 15);
  doc.text(bon.fournisseur.adresse, 350, infoY + 30);
  doc.text('Tel: ' + bon.fournisseur.telephone, 350, infoY + 45);
  doc.text('Email: ' + bon.fournisseur.email, 350, infoY + 60);

  doc.y = infoY + 80;
  doc.moveDown();

  // Tableau détaillé
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(7);
  doc.text('Ref', 50, tableTop, { width: 45 });
  doc.text('Designation', 95, tableTop, { width: 85 });
  doc.text('Cmd', 180, tableTop, { width: 30 });
  doc.text('Recue', 210, tableTop, { width: 35 });
  doc.text('Acceptee', 245, tableTop, { width: 40 });
  doc.text('Refusee', 285, tableTop, { width: 35 });
  doc.text('Action', 320, tableTop, { width: 55 });
  doc.text('Motif', 375, tableTop, { width: 80 });
  doc.text('Statut', 455, tableTop, { width: 95 });

  doc.moveTo(50, tableTop + 12).lineTo(550, tableTop + 12).stroke();

  doc.font('Helvetica').fontSize(7);
  let y = tableTop + 20;

  let totalAccepte = 0;
  let totalRefuse = 0;
  let totalQuarantaine = 0;
  let totalRetour = 0;
  let totalReserve = 0;

  bon.lignes.forEach(ligne => {
    if (y > 700) { doc.addPage(); y = 50; }

    // Extraire le motif depuis observations
    let motif = '-';
    if (ligne.observations) {
      const motifMatch = ligne.observations.match(/Motif: ([^|]+)/);
      if (motifMatch) motif = motifMatch[1].trim();
    }

    let action = ligne.actionNonConforme || '-';
    if (action === 'retour_fournisseur') action = 'Retour';
    else if (action === 'quarantaine') action = 'Quarantaine';
    else if (action === 'accepter_reserve') action = 'Avec reserve';
    else if (action === 'aucune') action = '-';

    let statut = ligne.statutQualite || 'EN_ATTENTE';
    if (statut === 'ACCEPTE') statut = 'Accepte';
    else if (statut === 'REFUSE') statut = 'Refuse';
    else if (statut === 'QUARANTAINE') statut = 'Quarantaine';
    else if (statut === 'RETOUR') statut = 'Retour fourn.';
    else if (statut === 'ACCEPTE_RESERVE') statut = 'Accepte reserve';
    else if (statut === 'ACCEPTE_APRES_QUARANTAINE') statut = 'Accepte ap. quar.';
    else if (statut === 'RETOUR_APRES_QUARANTAINE') statut = 'Retour ap. quar.';
    else if (statut === 'REJETE') statut = 'Rejete';
    else if (statut === 'EN_ATTENTE') statut = 'En attente';

    doc.text(ligne.article.reference, 50, y, { width: 45 });
    doc.text(ligne.article.designation, 95, y, { width: 85 });
    doc.text(String(ligne.quantiteCommandee), 180, y, { width: 30 });
    doc.text(String(ligne.quantiteRecue), 210, y, { width: 35 });
    doc.text(String(ligne.quantiteAcceptee), 245, y, { width: 40 });
    doc.text(String(ligne.quantiteRefusee), 285, y, { width: 35 });
    doc.text(action, 320, y, { width: 55 });
    doc.text(motif.substring(0, 25), 375, y, { width: 80 });
    doc.text(statut, 455, y, { width: 95 });

    totalAccepte += ligne.quantiteAcceptee;
    totalRefuse += ligne.quantiteRefusee;

    if (ligne.statutQualite === 'QUARANTAINE') totalQuarantaine += ligne.quantiteRefusee;
    if (ligne.statutQualite === 'RETOUR' || ligne.statutQualite === 'RETOUR_APRES_QUARANTAINE') totalRetour += ligne.quantiteRefusee;
    if (ligne.statutQualite === 'ACCEPTE_RESERVE') totalReserve += ligne.quantiteAcceptee;

    y += 18;
  });

  doc.moveTo(50, y + 5).lineTo(550, y + 5).stroke();

  // Résumé
  y += 20;
  doc.font('Helvetica-Bold').fontSize(11).text('Resume', 50, y);
  y += 18;
  doc.font('Helvetica').fontSize(9);

  doc.text('Total articles commandes: ' + bon.lignes.reduce((s, l) => s + l.quantiteCommandee, 0), 50, y);
  doc.text('Total recus: ' + bon.lignes.reduce((s, l) => s + l.quantiteRecue, 0), 300, y);
  y += 15;
  doc.text('Total acceptes: ' + totalAccepte, 50, y);
  doc.text('Total refuses: ' + totalRefuse, 300, y);
  y += 15;

  if (totalQuarantaine > 0 || totalRetour > 0 || totalReserve > 0) {
    doc.font('Helvetica-Bold').fontSize(9);
    if (totalQuarantaine > 0) { doc.text('En quarantaine: ' + totalQuarantaine, 50, y); y += 15; }
    if (totalRetour > 0) { doc.text('Retour fournisseur: ' + totalRetour, 50, y); y += 15; }
    if (totalReserve > 0) { doc.text('Acceptes avec reserve: ' + totalReserve, 50, y); y += 15; }
  }

  // Ecarts
  const ecarts = bon.lignes.filter(l => l.quantiteRecue !== l.quantiteCommandee);
  if (ecarts.length > 0) {
    y += 10;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).text('Ecarts quantitatifs', 50, y);
    y += 18;
    doc.font('Helvetica').fontSize(9);
    ecarts.forEach(l => {
      const ecart = l.quantiteRecue - l.quantiteCommandee;
      const signe = ecart > 0 ? '+' : '';
      doc.text(l.article.reference + ' - ' + l.article.designation + ' : Cmd ' + l.quantiteCommandee + ' / Recu ' + l.quantiteRecue + ' (ecart: ' + signe + ecart + ')', 50, y);
      y += 14;
    });
  }

  // Détail des non-conformités
  const nonConformes = bon.lignes.filter(l => l.quantiteRefusee > 0);
  if (nonConformes.length > 0) {
    y += 10;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).text('Detail des non-conformites', 50, y);
    y += 18;
    doc.font('Helvetica').fontSize(9);
    nonConformes.forEach(l => {
      let motif = '-';
      if (l.observations) {
        const m = l.observations.match(/Motif: ([^|]+)/);
        if (m) motif = m[1].trim();
      }
      let action = l.actionNonConforme || '-';
      if (action === 'retour_fournisseur') action = 'Retour fournisseur';
      else if (action === 'quarantaine') action = 'Mise en quarantaine';
      else if (action === 'accepter_reserve') action = 'Accepte avec reserve';

      doc.text(l.article.reference + ' : ' + l.quantiteRefusee + ' refuse(s) - Action: ' + action + ' - Motif: ' + motif, 50, y);
      y += 14;
    });
  }

  // Contrôle qualité
  if (bon.controleQualite) {
    y += 10;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).text('Controle Qualite', 50, y);
    y += 18;
    doc.font('Helvetica').fontSize(9);
    doc.text('Resultat: ' + bon.controleQualite.resultat, 50, y); y += 14;
    doc.text('Date controle: ' + bon.controleQualite.dateControle.toLocaleDateString('fr-FR'), 50, y); y += 14;
    if (bon.controleQualite.commentaire) {
      doc.text('Commentaire: ' + bon.controleQualite.commentaire, 50, y); y += 14;
    }
  }

  // Signatures
  doc.moveDown(3);
  const sigY = doc.y > 680 ? 50 : doc.y + 20;
  if (doc.y > 680) doc.addPage();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(9).font('Helvetica');
  const sY = doc.y;
  doc.text('Resp. Reception:', 50, sY);
  doc.text('Fournisseur:', 350, sY);
  doc.moveTo(50, sY + 30).lineTo(200, sY + 30).stroke();
  doc.moveTo(350, sY + 30).lineTo(500, sY + 30).stroke();
  doc.text('Date: ________________', 50, sY + 40);
  doc.text('Date: ________________', 350, sY + 40);

  doc.moveDown(4);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(8).text('WMS ENSIAS - Bon de reception genere automatiquement le ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

router.get('/quarantaine', async (req, res) => {
  const lignesQuarantaine = await prisma.ligneBonReception.findMany({
    where: { statutQualite: 'QUARANTAINE' },
    include: { 
      article: true, 
      bonReception: { include: { fournisseur: true } } 
    }
  });
  res.render('reception/quarantaine', { lignes: lignesQuarantaine });
});

router.post('/quarantaine/decision/:id', async (req, res) => {
  const ligneId = parseInt(req.params.id);
  const { decision, commentaire } = req.body;
  
  const ligne = await prisma.ligneBonReception.findUnique({
    where: { id: ligneId },
    include: { article: true, bonReception: { include: { fournisseur: true } } }
  });

  if (decision === 'accepter') {
    await prisma.mouvementStock.create({
      data: {
        type: 'ENTREE',
        quantite: ligne.quantiteRefusee,
        articleId: ligne.articleId
      }
    });

    const article = await prisma.article.findUnique({ where: { id: ligne.articleId } });
    const mouvements = await prisma.mouvementStock.findMany({
      where: { articleId: article.id, type: 'ENTREE' }
    });
    const totalQte = mouvements.reduce((sum, m) => sum + m.quantite, 0);
    const newCump = totalQte > 0 ? ((article.coutMoyenPondere * (totalQte - ligne.quantiteRefusee)) + (article.prix * ligne.quantiteRefusee)) / totalQte : article.prix;
    await prisma.article.update({
      where: { id: article.id },
      data: { coutMoyenPondere: newCump }
    });

    await prisma.ligneBonReception.update({
      where: { id: ligneId },
      data: { 
        statutQualite: 'ACCEPTE_APRES_QUARANTAINE',
        observations: (ligne.observations || '') + ' | Quarantaine: ACCEPTÉ - ' + (commentaire || '')
      }
    });

    await prisma.notification.create({
      data: {
        message: `Quarantaine - ${ligne.article.reference} (${ligne.quantiteRefusee} unités) : ACCEPTÉ après inspection. Stock mis à jour.`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });

  } else if (decision === 'retour') {
    await prisma.ligneBonReception.update({
      where: { id: ligneId },
      data: { 
        statutQualite: 'RETOUR_APRES_QUARANTAINE',
        observations: (ligne.observations || '') + ' | Quarantaine: RETOUR FOURNISSEUR - ' + (commentaire || '')
      }
    });

    await prisma.notification.create({
      data: {
        message: `Quarantaine - ${ligne.article.reference} (${ligne.quantiteRefusee} unités) : RETOUR FOURNISSEUR. Fournisseur: ${ligne.bonReception.fournisseur.nom}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });
    await prisma.notification.create({
      data: {
        message: `Retour fournisseur après quarantaine : ${ligne.article.reference} (${ligne.quantiteRefusee}) → ${ligne.bonReception.fournisseur.nom}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });

  } else if (decision === 'rejeter') {
    await prisma.ligneBonReception.update({
      where: { id: ligneId },
      data: { 
        statutQualite: 'REJETE',
        observations: (ligne.observations || '') + ' | Quarantaine: REJETÉ/DÉTRUIT - ' + (commentaire || '')
      }
    });

    await prisma.notification.create({
      data: {
        message: `Quarantaine - ${ligne.article.reference} (${ligne.quantiteRefusee} unités) : REJETÉ. Motif: ${commentaire || 'Non spécifié'}.`,
        lien: '/reception/quarantaine',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  res.redirect('/reception/quarantaine');
});

router.post('/decision-ecart/:id', async (req, res) => {
  const bonId = parseInt(req.params.id);
  const { decision } = req.body;
  
  const bon = await prisma.bonReception.findUnique({
    where: { id: bonId },
    include: { lignes: { include: { article: true } }, fournisseur: true }
  });

  if (decision === 'accepter_surplus') {
    for (const ligne of bon.lignes) {
      if (ligne.quantiteRecue > ligne.quantiteCommandee) {
        await prisma.ligneBonReception.update({
          where: { id: ligne.id },
          data: { 
            observations: 'Surplus de ' + (ligne.quantiteRecue - ligne.quantiteCommandee) + ' accepté - Fournisseur notifié'
          }
        });
      }
    }

    const surplusDetails = bon.lignes
      .filter(l => l.quantiteRecue > l.quantiteCommandee)
      .map(l => l.article.reference + ' (+' + (l.quantiteRecue - l.quantiteCommandee) + ')');

    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : surplus ACCEPTÉ. Articles: ${surplusDetails.join(', ')}. Fournisseur ${bon.fournisseur.nom} notifié. Procédez au contrôle qualité.`,
        lien: '/reception/controle/' + bonId,
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });

    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : surplus accepté. ${surplusDetails.join(', ')}. Fournisseur ${bon.fournisseur.nom} notifié.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });

    return res.redirect('/reception');

  } else if (decision === 'refuser_surplus') {
    for (const ligne of bon.lignes) {
      if (ligne.quantiteRecue > ligne.quantiteCommandee) {
        await prisma.ligneBonReception.update({
          where: { id: ligne.id },
          data: { 
            quantiteRecue: ligne.quantiteCommandee,
            observations: 'Surplus de ' + (ligne.quantiteRecue - ligne.quantiteCommandee) + ' refusé et retourné au fournisseur'
          }
        });
      }
    }

    const surplus = bon.lignes
      .filter(l => l.quantiteRecue > l.quantiteCommandee)
      .map(l => l.article.reference + ' (surplus: ' + (l.quantiteRecue - l.quantiteCommandee) + ')');

    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : surplus refusé et retourné à ${bon.fournisseur.nom}. ${surplus.join(', ')}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });
    await prisma.notification.create({
      data: {
        message: `Surplus retourné à ${bon.fournisseur.nom} pour Bon ${bon.numero}. ${surplus.join(', ')}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  return res.redirect('/reception');
});

router.get('/bon-retour/:id', async (req, res) => {
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

  const articlesRetour = [];
  bon.lignes.forEach(ligne => {
    if (ligne.observations && ligne.observations.includes('Surplus') && ligne.observations.includes('refus')) {
      const match = ligne.observations.match(/Surplus de (\d+)/);
      if (match) {
        articlesRetour.push({
          reference: ligne.article.reference,
          designation: ligne.article.designation,
          quantite: parseInt(match[1]),
          motif: 'Surplus refusé - Écart quantitatif',
          type: 'SURPLUS',
          prix: ligne.article.prix
        });
      }
    }
    
    if (ligne.actionNonConforme === 'retour_fournisseur' && ligne.quantiteRefusee > 0) {
      let motif = 'Non conforme';
      if (ligne.observations) {
        const motifMatchQualite = ligne.observations.match(/QUALITE.*Motif: ([^|]+)/);
        const motifMatchSimple = ligne.observations.match(/Motif: ([^|]+)/);
        if (motifMatchQualite) motif = motifMatchQualite[1].trim();
        else if (motifMatchSimple) motif = motifMatchSimple[1].trim();
      }
      articlesRetour.push({
        reference: ligne.article.reference,
        designation: ligne.article.designation,
        quantite: ligne.quantiteRefusee,
        motif: 'Qualité - ' + motif,
        type: 'QUALITE',
        prix: ligne.article.prix
      });
    }
    
    if (ligne.statutQualite === 'RETOUR_APRES_QUARANTAINE' && ligne.quantiteRefusee > 0) {
      let motif = 'Rejeté après quarantaine';
      if (ligne.observations) {
        const motifMatch = ligne.observations.match(/Motif: ([^|]+)/);
        if (motifMatch) motif = 'Quarantaine - ' + motifMatch[1].trim();
      }
      const dejaAjoute = articlesRetour.some(a => a.reference === ligne.article.reference && a.type === 'QUALITE');
      if (!dejaAjoute) {
        articlesRetour.push({
          reference: ligne.article.reference,
          designation: ligne.article.designation,
          quantite: ligne.quantiteRefusee,
          motif: motif,
          type: 'QUARANTAINE',
          prix: ligne.article.prix
        });
      }
    }
  });

  if (articlesRetour.length === 0) return res.status(404).send('Aucun article à retourner pour ce bon');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=RETOUR-' + bon.numero + '.pdf');
  doc.pipe(res);

  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('BON DE RETOUR FOURNISSEUR', { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Reference:', 50, infoY);
  doc.font('Helvetica');
  doc.text('Bon de reception: ' + bon.numero, 50, infoY + 15);
  doc.text('Date reception: ' + bon.date.toLocaleDateString('fr-FR'), 50, infoY + 30);
  doc.text('Date retour: ' + new Date().toLocaleDateString('fr-FR'), 50, infoY + 45);
  if (bon.controleQualite) {
    doc.text('Resultat controle: ' + bon.controleQualite.resultat, 50, infoY + 60);
  }

  doc.font('Helvetica-Bold').text('Fournisseur:', 350, infoY);
  doc.font('Helvetica');
  doc.text(bon.fournisseur.nom, 350, infoY + 15);
  doc.text(bon.fournisseur.adresse, 350, infoY + 30);
  doc.text('Tel: ' + bon.fournisseur.telephone, 350, infoY + 45);
  doc.text('Email: ' + bon.fournisseur.email, 350, infoY + 60);

  doc.y = infoY + 90;
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop2 = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Reference', 50, tableTop2, { width: 70 });
  doc.text('Designation', 120, tableTop2, { width: 130 });
  doc.text('Qte', 250, tableTop2, { width: 30 });
  doc.text('Prix unit.', 280, tableTop2, { width: 60 });
  doc.text('Type', 340, tableTop2, { width: 60 });
  doc.text('Motif', 400, tableTop2, { width: 150 });
  
  doc.moveTo(50, tableTop2 + 15).lineTo(550, tableTop2 + 15).stroke();
  
  doc.font('Helvetica').fontSize(8);
  let y2 = tableTop2 + 25;
  let totalRetour = 0;
  
  articlesRetour.forEach(a => {
    const total = a.quantite * a.prix;
    totalRetour += total;
    doc.text(a.reference, 50, y2, { width: 70 });
    doc.text(a.designation, 120, y2, { width: 130 });
    doc.text(String(a.quantite), 250, y2, { width: 30 });
    doc.text(a.prix.toFixed(2) + ' DH', 280, y2, { width: 60 });
    doc.text(a.type, 340, y2, { width: 60 });
    doc.text(a.motif, 400, y2, { width: 150 });
    y2 += 25;
  });

  doc.moveTo(50, y2 + 5).lineTo(550, y2 + 5).stroke();
  y2 += 15;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total articles retournes: ' + articlesRetour.reduce((s, a) => s + a.quantite, 0), 50, y2);
  doc.text('Valeur totale: ' + totalRetour.toFixed(2) + ' DH', 300, y2);

  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(10).text('Action demandee:');
  doc.font('Helvetica').fontSize(9);
  doc.text('Nous vous retournons les articles ci-dessus pour les motifs indiques.');
  doc.text('Merci de proceder au remplacement ou au remboursement dans les meilleurs delais.');

  doc.moveDown(2);
  const sigY = doc.y;
  doc.text('Expediteur (WMS ENSIAS):', 50, sigY);
  doc.text('Fournisseur:', 350, sigY);
  doc.moveTo(50, sigY + 35).lineTo(200, sigY + 35).stroke();
  doc.moveTo(350, sigY + 35).lineTo(500, sigY + 35).stroke();
  doc.text('Date: ________________', 50, sigY + 45);
  doc.text('Date: ________________', 350, sigY + 45);

  doc.moveDown(4);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(8).text('WMS ENSIAS - Bon de retour genere automatiquement le ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

module.exports = router;